let recorder = null;
let chunks = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.streamId).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    stopRecording(msg.serverUrl, msg.participantId, msg.taskIndex)
      .then((result) => sendResponse(result))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

async function startRecording(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  chunks = [];
  recorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp8',
    videoBitsPerSecond: 1500000,
  });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.start(1000);
}

async function stopRecording(serverUrl, participantId, taskIndex) {
  if (!recorder || recorder.state === 'inactive') return { ok: false, error: 'Not recording' };

  return new Promise((resolve) => {
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      chunks = [];

      recorder.stream.getTracks().forEach(t => t.stop());
      recorder = null;

      // Stash the recording locally so the annotation editor tab can play it
      // back immediately, without waiting on (or depending on) the upload.
      if (participantId && taskIndex) {
        try {
          await putRecording(recordingKey(participantId, taskIndex), blob);
        } catch (e) {
          console.warn('Failed to stash recording for editor:', e?.message || e);
        }
      }

      if (serverUrl && participantId && taskIndex) {
        try {
          const res = await fetch(
            `${serverUrl}/api/upload-recording?participantId=${participantId}&taskIndex=${taskIndex}`,
            { method: 'POST', body: blob }
          );
          if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
          resolve({ ok: true });
        } catch (err) {
          resolve({ ok: false, error: err.message });
        }
      } else {
        resolve({ ok: false, error: 'Missing upload params' });
      }
    };
    recorder.stop();
  });
}
