const DEFAULT_SERVER = 'https://ui-rater-production.up.railway.app';

let collectedInteractions = [];
let recordingTabId = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'extension/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Recording tab video for the study',
    });
  }
}

async function startRecording(tabId) {
  await ensureOffscreen();
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(id);
    });
  });
  recordingTabId = tabId;
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'START_RECORDING', streamId }, (res) => {
      if (res?.ok) resolve();
      else reject(new Error(res?.error || 'Failed to start recording'));
    });
  });
}

async function stopRecording(serverUrl, participantId, taskIndex) {
  recordingTabId = null;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'STOP_RECORDING',
      serverUrl,
      participantId,
      taskIndex,
    }, (res) => {
      resolve(res?.ok || false);
    });
  });
}

// Fire-and-resolve a message to a content script; never rejects.
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, () => { void chrome.runtime.lastError; resolve(); });
    } catch {
      resolve();
    }
  });
}

// Persist the in-memory interactions and stop + upload the recording for the
// current task. Shared by the popup and the on-page Done control.
async function snapshotAndStopRecording() {
  await chrome.storage.local.set({ _snapshotInteractions: [...collectedInteractions] });
  collectedInteractions = [];
  const data = await chrome.storage.local.get(['serverUrl', 'participantId', 'currentTaskIndex']);
  const serverUrl = data.serverUrl || DEFAULT_SERVER;
  const taskIndex = (data.currentTaskIndex || 0) + 1;
  await stopRecording(serverUrl, data.participantId, taskIndex);
}

// Start the current task on the given tab: capture the tab (must happen while
// the activeTab grant from this invocation is valid), mark tracking, then open
// the task site. Shared by the popup's Begin button and the begin_task command.
async function beginTask(tab) {
  if (!tab || tab.id == null) return { ok: false, error: 'No active tab' };

  const data = await chrome.storage.local.get(['tasks', 'currentTaskIndex', '_tracking']);
  if (!Array.isArray(data.tasks) || data.tasks.length === 0) return { ok: false, error: 'No tasks loaded' };
  if (data._tracking) return { ok: false, error: 'A task is already in progress' };
  const index = data.currentTaskIndex || 0;
  if (index >= data.tasks.length) return { ok: false, error: 'All tasks complete' };
  const task = data.tasks[index];

  collectedInteractions = [];

  // Capture first, before any navigation revokes the activeTab grant.
  let recError = null;
  try {
    await startRecording(tab.id);
  } catch (err) {
    recError = err.message;
  }

  const now = Date.now();
  await chrome.storage.local.set({
    _tracking: true,
    _originTime: now,
    _viewStart: new Date(now).toISOString(),
  });

  if (task.site_url) {
    await chrome.tabs.update(tab.id, { url: task.site_url });
  } else {
    const started = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'START_TRACKING' }, () => resolve(!chrome.runtime.lastError));
    });
    if (!started) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extension/content.js'] });
        await sendToTab(tab.id, { type: 'START_TRACKING' });
      } catch { /* page may be uninjectable */ }
    }
  }

  return { ok: !recError, error: recError };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get(['participantId', 'serverUrl', 'tasks', 'currentTaskIndex'], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (msg.type === 'APPEND_INTERACTIONS') {
    if (Array.isArray(msg.interactions)) {
      collectedInteractions.push(...msg.interactions);
    }
    chrome.storage.local.get(['participantId', 'serverUrl', 'currentTaskIndex', 'tasks'], (data) => {
      if (!data.participantId || !data.tasks) return;
      const serverUrl = data.serverUrl || DEFAULT_SERVER;
      fetch(`${serverUrl}/api/partial-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId: data.participantId,
          trialIndex: (data.currentTaskIndex || 0) + 1,
          view_start: msg.viewStart,
          interactions: collectedInteractions,
        }),
      }).catch(() => {});
    });
    return false;
  }

  if (msg.type === 'BEGIN_TASK') {
    (async () => {
      let tab = null;
      if (msg.tabId != null) {
        tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      }
      if (!tab) {
        // Service workers have no "current window"; use the last focused one.
        [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      }
      sendResponse(await beginTask(tab));
    })();
    return true;
  }

  if (msg.type === 'SNAPSHOT_AND_STOP_RECORDING') {
    (async () => {
      try {
        await snapshotAndStopRecording();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Finish the current task: stop tracking, snapshot timing + interactions, stop
  // the recording, then open the review/annotation editor. Triggered by the
  // on-page Done control or the popup's Done button.
  if (msg.type === 'FINISH_TASK') {
    (async () => {
      try {
        let tabId = recordingTabId;
        if (tabId == null) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tab?.id;
        }
        if (tabId != null) await sendToTab(tabId, { type: 'STOP_TRACKING' });
        await new Promise((r) => setTimeout(r, 300)); // let the final flush arrive

        const stored = await chrome.storage.local.get(['_viewStart']);
        const viewStart = stored._viewStart || new Date().toISOString();
        const durationMs = Date.now() - new Date(viewStart).getTime();
        await chrome.storage.local.set({ _durationMs: durationMs, _viewStart: viewStart });

        await snapshotAndStopRecording();

        // Mark the attempt as awaiting annotation so the on-page panel shows a
        // "finish your review" state instead of offering to begin again.
        await chrome.storage.local.set({ _reviewing: true });

        await chrome.windows.create({
          url: chrome.runtime.getURL('extension/editor.html'),
          type: 'popup',
          width: 1100,
          height: 900,
        });

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Skip the current task entirely: stop recording, advance to the next task.
  if (msg.type === 'SKIP_TASK_FULL') {
    (async () => {
      try {
        let tabId = recordingTabId;
        if (tabId == null) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tab?.id;
        }
        if (tabId != null) await sendToTab(tabId, { type: 'STOP_TRACKING' });

        const data = await chrome.storage.local.get(['serverUrl', 'participantId', 'currentTaskIndex', 'tasks']);
        const taskIndex = (data.currentTaskIndex || 0) + 1;
        await stopRecording(data.serverUrl || DEFAULT_SERVER, data.participantId, taskIndex);
        collectedInteractions = [];

        const advanced = (data.currentTaskIndex || 0) + 1;
        const total = data.tasks?.length || 0;
        await chrome.storage.local.set({ currentTaskIndex: advanced });
        await chrome.storage.local.remove(['_tracking', '_originTime', '_viewStart', '_durationMs', '_snapshotInteractions', '_reviewing']);

        sendResponse({ ok: true, finished: advanced >= total });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'COMPLETE_TASK') {
    chrome.storage.local.get(['participantId', 'serverUrl', 'currentTaskIndex', 'tasks', '_snapshotInteractions'], async (data) => {
      if (!data.participantId || !data.tasks) {
        sendResponse({ ok: false, error: 'Not configured' });
        return;
      }
      const serverUrl = data.serverUrl || DEFAULT_SERVER;
      const allInteractions = data._snapshotInteractions || [...collectedInteractions];
      const viewStart = msg.viewStart;
      const durationMs = msg.durationMs || 0;
      const feedback = msg.feedback || '';
      const issueMarkers = Array.isArray(msg.issueMarkers) ? msg.issueMarkers : [];
      const taskIndex = (data.currentTaskIndex || 0) + 1;
      const participantId = data.participantId;

      try {
        const res = await fetch(`${serverUrl}/api/complete-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            participantId,
            trialIndex: taskIndex,
            view_start: viewStart,
            duration_ms: durationMs,
            interactions: allInteractions,
            feedback,
            issue_markers: issueMarkers,
          }),
        });
        if (!res.ok) throw new Error(`Server error: ${res.status}`);

        collectedInteractions = [];
        await chrome.storage.local.remove(['_snapshotInteractions', '_reviewing', '_tracking', '_originTime', '_viewStart', '_durationMs']);

        const nextIndex = taskIndex;
        if (nextIndex < data.tasks.length) {
          await chrome.storage.local.set({ currentTaskIndex: nextIndex });
        }
        sendResponse({ ok: true, finished: nextIndex >= data.tasks.length });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true;
  }

  if (msg.type === 'SKIP_TASK') {
    (async () => {
      chrome.storage.local.get(['serverUrl', 'participantId', 'currentTaskIndex'], async (data) => {
        const taskIndex = (data.currentTaskIndex || 0) + 1;
        await stopRecording(data.serverUrl || DEFAULT_SERVER, data.participantId, taskIndex);
      });
    })();
    return false;
  }

  if (msg.type === 'CLEAR_INTERACTIONS') {
    collectedInteractions = [];
    return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['serverUrl'], (data) => {
    if (!data.serverUrl) {
      chrome.storage.local.set({ serverUrl: DEFAULT_SERVER });
    }
  });
});

// Keyboard shortcut to begin the next task. A command invocation grants the
// activeTab permission that tab capture needs, so recording can start without
// opening the toolbar popup.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'begin_task') return;
  let target = tab;
  if (!target) {
    [target] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  await beginTask(target);
});
