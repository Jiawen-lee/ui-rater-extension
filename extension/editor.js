// Review & annotation editor. Opened in a full browser tab after the participant
// clicks "Done" on a task. Loads the just-recorded video from IndexedDB, lets the
// participant drop timestamped issue markers with optional notes, then submits the
// markers + overall feedback and advances the study to the next task.

const DEFAULT_SERVER = 'https://ui-rater-production.up.railway.app';

const $ = (id) => document.getElementById(id);

let markers = [];      // { id, ts_ms, note }
let markerSeq = 0;
let ctx = null;        // { participantId, taskIndex, promptText, total }
let videoUrl = null;

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function currentTimeMs() {
  const v = $('video');
  const t = v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
  return Math.round(t * 1000);
}

function renderMarkers() {
  const list = $('markerList');
  list.innerHTML = '';
  $('markerEmpty').classList.toggle('hidden', markers.length > 0);

  for (const marker of markers) {
    const li = document.createElement('li');
    li.className = 'marker';

    const top = document.createElement('div');
    top.className = 'marker-top';

    const time = document.createElement('button');
    time.className = 'marker-time';
    time.type = 'button';
    time.textContent = `⚑ ${fmt(marker.ts_ms / 1000)}`;
    time.title = 'Jump to this moment in the video';
    time.addEventListener('click', () => {
      const v = $('video');
      if (v && videoUrl) { v.currentTime = marker.ts_ms / 1000; v.play().catch(() => {}); }
    });

    const del = document.createElement('button');
    del.className = 'marker-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Remove this issue';
    del.addEventListener('click', () => {
      markers = markers.filter((m) => m.id !== marker.id);
      renderMarkers();
    });

    top.appendChild(time);
    top.appendChild(del);

    const note = document.createElement('textarea');
    note.placeholder = 'What went wrong here? (optional)';
    note.value = marker.note;
    note.addEventListener('input', () => { marker.note = note.value; });

    li.appendChild(top);
    li.appendChild(note);
    list.appendChild(li);
  }
}

function addMarker() {
  const ts = currentTimeMs();
  markers.push({ id: ++markerSeq, ts_ms: ts, note: '' });
  markers.sort((a, b) => a.ts_ms - b.ts_ms);
  renderMarkers();
  // Focus the note field of the marker we just added.
  const items = $('markerList').querySelectorAll('.marker');
  for (const item of items) {
    const timeText = item.querySelector('.marker-time').textContent;
    if (timeText === `⚑ ${fmt(ts / 1000)}`) {
      const ta = item.querySelector('textarea');
      if (ta) ta.focus();
      break;
    }
  }
}

function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind || ''}`.trim();
  el.classList.toggle('hidden', !msg);
}

async function loadContext() {
  const data = await chrome.storage.local.get([
    'participantId', 'serverUrl', 'tasks', 'currentTaskIndex', '_viewStart', '_durationMs',
  ]);

  if (!data.participantId || !Array.isArray(data.tasks)) {
    throw new Error('No active study session found.');
  }

  const index = data.currentTaskIndex || 0;
  const task = data.tasks[index];
  ctx = {
    participantId: data.participantId,
    serverUrl: data.serverUrl || DEFAULT_SERVER,
    taskIndex: index + 1,
    total: data.tasks.length,
    promptText: task ? task.task_prompt : '',
    viewStart: data._viewStart,
    durationMs: data._durationMs,
  };

  $('progressLabel').textContent = `Task ${ctx.taskIndex} of ${ctx.total} — review`;
  $('taskPrompt').textContent = ctx.promptText || '';
}

function markVideoMissing() {
  const video = $('video');
  video.classList.add('hidden');
  $('videoMissing').classList.remove('hidden');
  $('flagBtn').disabled = true;
  $('flagTime').textContent = '—';
}

async function loadVideo() {
  const video = $('video');

  // Fast path: the offscreen recorder may have stashed the blob locally.
  let blob = null;
  try {
    blob = await getRecording(recordingKey(ctx.participantId, ctx.taskIndex));
  } catch (e) {
    console.warn('Failed to read recording from IndexedDB:', e);
  }

  if (blob) {
    videoUrl = URL.createObjectURL(blob);
    video.src = videoUrl;
    return;
  }

  // Fall back to the copy the extension already uploaded to the server. If that
  // load also fails, show the "recording unavailable" notice.
  const serverSrc = `${ctx.serverUrl}/api/upload-recording`
    + `?participantId=${encodeURIComponent(ctx.participantId)}&taskIndex=${ctx.taskIndex}`;
  video.addEventListener('error', markVideoMissing, { once: true });
  video.src = serverSrc;
}

async function submit() {
  $('submitBtn').disabled = true;
  $('skipBtn').disabled = true;
  setStatus('Saving…', '');

  const issueMarkers = markers.map((m) => ({
    ts_ms: m.ts_ms,
    note: (m.note || '').trim(),
    created_at: new Date().toISOString(),
  }));

  try {
    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'COMPLETE_TASK',
        viewStart: ctx.viewStart,
        durationMs: ctx.durationMs,
        feedback: $('feedbackInput').value.trim(),
        issueMarkers,
      }, resolve);
    });

    if (!result || !result.ok) {
      throw new Error(result?.error || 'Failed to save.');
    }

    // Clean up the local recording and per-attempt timing state.
    try { await deleteRecording(recordingKey(ctx.participantId, ctx.taskIndex)); } catch { /* ignore */ }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    await chrome.storage.local.remove(['_tracking', '_originTime', '_viewStart', '_durationMs']);

    showDone(result.finished);
  } catch (err) {
    setStatus(err.message || 'Failed to save.', 'error');
    $('submitBtn').disabled = false;
    $('skipBtn').disabled = false;
  }
}

function showDone(finished) {
  $('editorWrap').classList.add('hidden');
  const banner = $('doneBanner');
  banner.classList.remove('hidden');
  if (finished) {
    $('doneTitle').textContent = 'All tasks complete!';
    $('doneText').textContent = 'Thank you for participating. This window will close automatically.';
  } else {
    $('doneTitle').textContent = 'Saved.';
    $('doneText').textContent = 'Returning to the study — this window will close automatically.';
  }
  // Close the editor window; the side panel auto-advances to the next task.
  setTimeout(() => window.close(), 1600);
}

function wireEvents() {
  $('flagBtn').addEventListener('click', addMarker);
  $('submitBtn').addEventListener('click', submit);
  $('skipBtn').addEventListener('click', () => { markers = []; submit(); });

  const video = $('video');
  const updateFlagTime = () => { $('flagTime').textContent = fmt(video.currentTime); };
  video.addEventListener('timeupdate', updateFlagTime);
  video.addEventListener('loadedmetadata', updateFlagTime);

  // "f" flags an issue at the current time (unless typing in a note/feedback).
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); if (!$('flagBtn').disabled) addMarker(); }
  });
}

async function init() {
  wireEvents();
  try {
    await loadContext();
    await loadVideo();
    renderMarkers();
  } catch (err) {
    setStatus(err.message || 'Could not load this task.', 'error');
    $('flagBtn').disabled = true;
    $('submitBtn').disabled = true;
    $('skipBtn').disabled = true;
  }
}

init();
