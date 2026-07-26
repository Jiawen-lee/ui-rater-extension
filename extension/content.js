(() => {
  let tracking = false;
  let interactions = [];
  let originTime = 0;
  let viewStart = '';
  let saveInterval = null;

  const WIDGET_ID = '__ui_rater_widget__';
  let widgetHost = null;

  function ts() {
    return Date.now() - originTime;
  }

  function tag(el) {
    if (!el || !el.tagName) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    if (el.className && typeof el.className === 'string') {
      s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return s;
  }

  function record(kind, e, extra) {
    if (!tracking) return;
    if (e && e.target && e.target.id === WIDGET_ID) return; // ignore our own control
    const entry = {
      kind,
      ts: ts(),
      url: location.href,
      ...extra,
    };
    if (e && e.target) {
      entry.tag = tag(e.target);
      if (e.clientX !== undefined) {
        entry.x = Math.round(e.clientX);
        entry.y = Math.round(e.clientY);
      }
    }
    interactions.push(entry);
  }

  function onClick(e) {
    const el = e.target;
    record('click', e, {
      text: (el.textContent || '').trim().slice(0, 80),
      href: el.closest('a')?.href || '',
    });
  }

  function onRightClick(e) {
    record('rightclick', e);
  }

  function onScroll() {
    record('scroll', null, {
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
    });
  }

  function onMouseMove(e) {
    record('mousemove', e);
  }

  function onInput(e) {
    const el = e.target;
    const value = el.value || el.textContent || el.innerText || '';
    record('input', e, {
      value: value.slice(0, 200),
      inputType: el.type || (el.isContentEditable ? 'contenteditable' : 'text'),
    });
  }

  function onKeydown(e) {
    record('keydown', e, {
      key: e.key,
      code: e.code,
      ctrl: e.ctrlKey || undefined,
      meta: e.metaKey || undefined,
      alt: e.altKey || undefined,
      shift: e.shiftKey || undefined,
    });
  }

  function onSubmit(e) {
    const form = e.target;
    record('formsubmit', null, {
      action: form.action || '',
      method: form.method || 'get',
      tag: tag(form),
    });
  }

  function onCopy() { record('copy', null); }
  function onPaste() { record('paste', null); }

  function onFocusIn(e) {
    const el = e.target;
    if (el.tagName && /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) {
      record('focus', e, { inputType: el.type || el.tagName.toLowerCase() });
    }
  }

  function onResize() {
    record('resize', null, {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    });
  }

  let scrollTimer = null;
  function onScrollThrottled() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      onScroll();
    }, 200);
  }

  let moveTimer = null;
  function onMouseMoveThrottled(e) {
    if (moveTimer) return;
    moveTimer = setTimeout(() => {
      moveTimer = null;
    }, 100);
    onMouseMove(e);
  }

  let resizeTimer = null;
  function onResizeThrottled() {
    if (resizeTimer) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      onResize();
    }, 300);
  }

  function attachListeners() {
    document.addEventListener('click', onClick, true);
    document.addEventListener('contextmenu', onRightClick, true);
    document.addEventListener('scroll', onScrollThrottled, true);
    document.addEventListener('mousemove', onMouseMoveThrottled, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('copy', onCopy, true);
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('resize', onResizeThrottled);
  }

  function detachListeners() {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('contextmenu', onRightClick, true);
    document.removeEventListener('scroll', onScrollThrottled, true);
    document.removeEventListener('mousemove', onMouseMoveThrottled, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('submit', onSubmit, true);
    document.removeEventListener('copy', onCopy, true);
    document.removeEventListener('paste', onPaste, true);
    document.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('resize', onResizeThrottled);
  }

  // Persistent on-page panel: shows the current task + progress, the Begin
  // shortcut when idle, and Done/Skip while recording — so the study runs
  // without reopening the toolbar popup. Rendered in a shadow root so page CSS
  // can't affect it, and driven entirely by chrome.storage state.
  let panelEls = null;

  function buildPanel() {
    widgetHost = document.createElement('div');
    widgetHost.id = WIDGET_ID;
    const shadow = widgetHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .card { position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
          width: 280px; background: #111827; color: #fff; border-radius: 12px;
          box-shadow: 0 6px 24px rgba(0,0,0,0.4); overflow: hidden;
          font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .top { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
          background: rgba(255,255,255,0.06); }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444;
          animation: pl 1.4s infinite; flex: none; }
        @keyframes pl { 0%,100%{opacity:1} 50%{opacity:.35} }
        .hdr { font-weight: 600; flex: 1; }
        .min { background: none; border: none; color: rgba(255,255,255,0.6);
          cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; }
        .body { padding: 10px 12px; }
        .prompt { color: #e5e7eb; max-height: 96px; overflow-y: auto; }
        .hint { margin-top: 10px; padding: 8px 10px; background: rgba(59,130,246,0.18);
          border: 1px solid rgba(59,130,246,0.5); border-radius: 8px; color: #dbeafe;
          text-align: center; }
        .hint kbd { background: #1f2937; border: 1px solid #374151; border-radius: 4px;
          padding: 1px 5px; font: inherit; }
        .actions { display: flex; gap: 8px; margin-top: 10px; }
        .actions button { flex: 1; border: none; border-radius: 8px; padding: 8px;
          font: 600 13px inherit; cursor: pointer; }
        .done { background: #16a34a; color: #fff; }
        .done:hover { background: #15803d; }
        .skip { background: #374151; color: #e5e7eb; }
        .skip:hover { background: #4b5563; }
      </style>
      <div class="card">
        <div class="top">
          <span class="dot" id="p-dot"></span>
          <span class="hdr" id="p-hdr"></span>
          <button class="min" id="p-min" title="Hide">–</button>
        </div>
        <div class="body">
          <div class="prompt" id="p-prompt"></div>
          <div class="hint" id="p-hint"></div>
          <div class="actions" id="p-actions">
            <button class="done" id="p-done">Done</button>
            <button class="skip" id="p-skip">Skip</button>
          </div>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(widgetHost);
    panelEls = {
      dot: shadow.getElementById('p-dot'),
      hdr: shadow.getElementById('p-hdr'),
      prompt: shadow.getElementById('p-prompt'),
      hint: shadow.getElementById('p-hint'),
      actions: shadow.getElementById('p-actions'),
      done: shadow.getElementById('p-done'),
      skip: shadow.getElementById('p-skip'),
    };
    panelEls.done.addEventListener('click', onPanelDone);
    panelEls.skip.addEventListener('click', onPanelSkip);
    shadow.getElementById('p-min').addEventListener('click', () => { widgetHost.style.display = 'none'; });
  }

  function updatePanel(view) {
    if (!view) {
      if (widgetHost) { widgetHost.remove(); widgetHost = null; panelEls = null; }
      return;
    }
    if (!widgetHost) buildPanel();
    widgetHost.style.display = '';

    panelEls.hdr.textContent = view.mode === 'done'
      ? 'All tasks complete' : `Task ${view.taskNum} of ${view.total}`;
    panelEls.dot.style.display = view.mode === 'tracking' ? '' : 'none';

    if (view.mode === 'done') {
      panelEls.prompt.textContent = 'Thank you for participating.';
      panelEls.hint.style.display = 'none';
      panelEls.actions.style.display = 'none';
      return;
    }

    panelEls.prompt.textContent = view.prompt || '';
    if (view.mode === 'tracking') {
      panelEls.hint.style.display = 'none';
      panelEls.actions.style.display = '';
    } else if (view.mode === 'reviewing') {
      panelEls.hint.style.display = '';
      panelEls.hint.textContent = 'Finish your notes in the review window.';
      panelEls.actions.style.display = 'none';
    } else { // idle
      panelEls.hint.style.display = '';
      panelEls.hint.innerHTML = 'Press <kbd>Alt+Shift+S</kbd> to begin';
      panelEls.actions.style.display = 'none';
    }
  }

  function refreshPanel() {
    chrome.storage.local.get(
      ['participantId', 'tasks', 'currentTaskIndex', '_tracking', '_reviewing'],
      (d) => {
        if (chrome.runtime.lastError) return;
        const active = !!(d.participantId && Array.isArray(d.tasks) && d.tasks.length);
        if (!active) { updatePanel(null); return; }
        const idx = d.currentTaskIndex || 0;
        if (idx >= d.tasks.length) { updatePanel({ mode: 'done' }); return; }
        const task = d.tasks[idx] || {};
        const mode = d._tracking ? 'tracking' : (d._reviewing ? 'reviewing' : 'idle');
        updatePanel({ mode, taskNum: idx + 1, total: d.tasks.length, prompt: task.task_prompt });
      },
    );
  }

  function onPanelDone() {
    if (!tracking) return;
    chrome.runtime.sendMessage({ type: 'FINISH_TASK' });
    stopTracking();
  }

  function onPanelSkip() {
    if (!tracking) return;
    chrome.runtime.sendMessage({ type: 'SKIP_TASK_FULL' });
    stopTracking();
  }

  function startTracking(resumeState) {
    if (tracking) return;
    tracking = true;

    if (resumeState) {
      originTime = resumeState.originTime;
      viewStart = resumeState.viewStart;
      interactions = [];
    } else {
      interactions = [];
      originTime = Date.now();
      viewStart = new Date().toISOString();
    }

    attachListeners();
    record('pageload', null, { url: location.href, title: document.title });

    chrome.storage.local.set({
      _tracking: true,
      _originTime: originTime,
      _viewStart: viewStart,
    });

    saveInterval = setInterval(flushToBackground, 10000);

    refreshPanel();
  }

  function flushToBackground() {
    if (interactions.length === 0) return;
    const batch = [...interactions];
    interactions = [];
    chrome.runtime.sendMessage({
      type: 'APPEND_INTERACTIONS',
      interactions: batch,
      viewStart,
    });
  }

  function stopTracking() {
    if (!tracking) return;
    tracking = false;
    detachListeners();
    if (saveInterval) {
      clearInterval(saveInterval);
      saveInterval = null;
    }
    flushToBackground();
    chrome.storage.local.remove(['_tracking', '_originTime', '_viewStart']);
    refreshPanel();
  }

  // Track SPA navigation
  const origPushState = history.pushState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    if (tracking) record('navigate', null, { url: location.href, method: 'pushState' });
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    if (tracking) record('navigate', null, { url: location.href, method: 'replaceState' });
  };
  window.addEventListener('popstate', () => {
    if (tracking) record('navigate', null, { url: location.href, method: 'popstate' });
  });

  // On page load, check if we should auto-resume tracking, and render the panel.
  chrome.storage.local.get(['_tracking', '_originTime', '_viewStart'], (data) => {
    if (data._tracking) {
      startTracking({
        originTime: data._originTime,
        viewStart: data._viewStart,
      });
    }
  });
  refreshPanel();

  // Keep the panel in sync as the study state changes (begin, done, skip, review).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('participantId' in changes || 'tasks' in changes || 'currentTaskIndex' in changes
      || '_tracking' in changes || '_reviewing' in changes) {
      refreshPanel();
    }
  });

  // Listen for messages from popup / background
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_TRACKING') {
      startTracking(null);
      sendResponse({ ok: true });
    } else if (msg.type === 'STOP_TRACKING') {
      flushToBackground();
      stopTracking();
      sendResponse({ ok: true });
    } else if (msg.type === 'PING') {
      sendResponse({ tracking, interactionCount: interactions.length });
    }
    return true;
  });
})();
