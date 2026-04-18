'use strict';
const statusEl = document.getElementById('status');
let mediaRecorder = null;
let chunks        = [];
let startTime     = null;
let timerInterval = null;
let discarded     = false;

const canvas = document.createElement('canvas');
const ctx    = canvas.getContext('2d');
let srcVideo     = null;
let camVideo     = null;
let rafId        = null;
let region       = null;
let annotationImg = null;
let cameraFlipped = true;
let camPosition   = 'br'; // tl | tr | bl | br (fallback)
let camXY         = null; // { x, y } normalized 0-1, overrides corner preset
let camLastOutOfBounds = false;

let camVisible   = true;
let camSizeRatio = 0.18; // fraction of min(canvas.width, canvas.height)
window.api.onFlipCamera(v => { cameraFlipped = v; });
window.api.onCamPosition(pos => { camPosition = pos; camXY = null; });
window.api.onCamPositionXY(pos => { camXY = pos; });
window.api.onCamVisible(v => { camVisible = v; });
window.api.onCamSize(r => { camSizeRatio = r; });

// Receive annotation frames from annotate window (null = clear)
window.api.onAnnotationFrame(dataUrl => {
  if (!dataUrl) { annotationImg = null; return; }
  const img = new Image();
  img.onload = () => { annotationImg = img; };
  img.src = dataUrl;
});

function drawLoop() {
  if (srcVideo && srcVideo.readyState >= 2) {
    if (region) {
      ctx.drawImage(srcVideo, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.drawImage(srcVideo, 0, 0, canvas.width, canvas.height);
    }

    // ── Camera bubble overlay ─────────────────────────────
    if (camVisible && camVideo && camVideo.readyState >= 2) {
      const size   = Math.round(Math.min(canvas.width, canvas.height) * camSizeRatio);
      const margin = Math.round(canvas.width * 0.02);
      const right  = canvas.width  - size - margin;
      const bottom = canvas.height - size - margin;
      let cx, cy, outOfBounds = false;
      if (camXY) {
        const rawCx = Math.round(camXY.x * canvas.width)  - size / 2;
        const rawCy = Math.round(camXY.y * canvas.height) - size / 2;
        // Fully off-screen = out of bounds (hide camera + red ring)
        outOfBounds = (rawCx + size < 0 || rawCx > canvas.width || rawCy + size < 0 || rawCy > canvas.height);
        // Clamp to keep partially-visible cameras from disappearing
        cx = Math.max(-size / 2, Math.min(canvas.width  - size / 2, rawCx));
        cy = Math.max(-size / 2, Math.min(canvas.height - size / 2, rawCy));
      } else {
        cx = camPosition === 'tl' || camPosition === 'bl' ? margin : right;
        cy = camPosition === 'tl' || camPosition === 'tr' ? margin : bottom;
      }

      if (!outOfBounds) {
        const r = size / 2;
        const vW = camVideo.videoWidth  || 640;
        const vH = camVideo.videoHeight || 480;
        const cropSize = Math.min(vW, vH);
        const sx = (vW - cropSize) / 2;
        const sy = (vH - cropSize) / 2;

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx + r, cy + r, r, 0, Math.PI * 2);
        ctx.clip();
        if (cameraFlipped) {
          ctx.translate(2 * cx + size, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(camVideo, sx, sy, cropSize, cropSize, cx, cy, size, size);
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx + r, cy + r, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth   = Math.max(3, size * 0.04);
        ctx.stroke();
        ctx.restore();
      }

      // Notify bubble if out-of-bounds state changed
      if (outOfBounds !== camLastOutOfBounds) {
        camLastOutOfBounds = outOfBounds;
        window.api.notifyCamOutOfBounds(outOfBounds);
      }
    }
  }

  // ── Annotation overlay ────────────────────────────────
  if (annotationImg) {
    ctx.drawImage(annotationImg, 0, 0, canvas.width, canvas.height);
  }

  rafId = requestAnimationFrame(drawLoop);
}

// ── Start ─────────────────────────────────────────────────
window.api.onStart(async ({ sourceId, cameraDeviceId, micDeviceId, region: reg }) => {
  region   = reg || null;
  discarded = false;
  chunks   = [];
  statusEl.textContent = 'Starting…';

  try {
    const stream = await captureSource(sourceId);
    if (!stream) throw new Error('Could not capture source');

    const track    = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    canvas.width   = region ? region.w : (settings.width  || 1920);
    canvas.height  = region ? region.h : (settings.height || 1080);

    srcVideo = document.createElement('video');
    srcVideo.srcObject = stream;
    srcVideo.muted = true;
    await srcVideo.play();

    // Camera
    if (cameraDeviceId) {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: cameraDeviceId }, width: 640, height: 640 },
          audio: false,
        });
        camVideo = document.createElement('video');
        camVideo.srcObject = camStream;
        camVideo.muted = true;
        await camVideo.play();
      } catch { camVideo = null; }
    } else {
      camVideo = null;
    }

    drawLoop();

    // Mic
    let micTrack = null;
    if (micDeviceId) {
      try {
        const ms = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: micDeviceId }, echoCancellation: true, noiseSuppression: true },
          video: false,
        });
        micTrack = ms.getAudioTracks()[0];
      } catch { /* denied */ }
    }

    const canvasStream = canvas.captureStream(30);
    const combined     = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...(micTrack ? [micTrack] : []),
    ]);

    const mimeType = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

    mediaRecorder = new MediaRecorder(combined, { mimeType });
    // Stream chunks directly to disk — nothing kept in RAM
    await window.api.createTempFile();
    let _writeQueue = Promise.resolve();
    mediaRecorder.ondataavailable = e => {
      if (e.data.size === 0) return;
      _writeQueue = _writeQueue.then(async () => {
        const ab = await e.data.arrayBuffer();
        await window.api.appendChunk(ab);
      });
    };
    mediaRecorder.onstop = async () => { await _writeQueue; handleStop(); };
    mediaRecorder.start(1000);

    startTime     = Date.now();
    timerInterval = setInterval(() => {
      window.api.timerTick(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    statusEl.textContent = 'Recording…';
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
});

// ── Switch source ─────────────────────────────────────────
window.api.onSwitchSource(async (sourceId) => {
  try {
    const newStream = await captureSource(sourceId);
    if (!newStream) return;
    const oldSrc = srcVideo;
    srcVideo = document.createElement('video');
    srcVideo.srcObject = newStream;
    srcVideo.muted = true;
    await srcVideo.play();
    oldSrc?.srcObject?.getTracks().forEach(t => t.stop());
    statusEl.textContent = 'Source switched.';
  } catch (e) {
    statusEl.textContent = `Switch failed: ${e.message}`;
  }
});

// ── Pause / resume ────────────────────────────────────────
let pausedAt = 0;
let pausedMs = 0;
window.api.onPause(isPaused => {
  if (!mediaRecorder) return;
  if (isPaused && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    pausedAt = Date.now();
    clearInterval(timerInterval);
    statusEl.textContent = 'Paused';
  } else if (!isPaused && mediaRecorder.state === 'paused') {
    pausedMs += Date.now() - pausedAt;
    mediaRecorder.resume();
    timerInterval = setInterval(() => {
      window.api.timerTick(Math.floor((Date.now() - startTime - pausedMs) / 1000));
    }, 1000);
    statusEl.textContent = 'Recording…';
  }
});

// ── Stop / discard ────────────────────────────────────────
window.api.onStop(() => {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  if (mediaRecorder.state === 'paused') mediaRecorder.resume();
  mediaRecorder.stop();
});
window.api.onDiscard(() => {
  discarded = true;
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  if (mediaRecorder.state === 'paused') mediaRecorder.resume();
  mediaRecorder.stop();
});

async function handleStop() {
  clearInterval(timerInterval);
  cancelAnimationFrame(rafId);
  srcVideo?.srcObject?.getTracks().forEach(t => t.stop());
  camVideo?.srcObject?.getTracks().forEach(t => t.stop());

  if (discarded) { window.api.recordingDiscarded(); return; }

  try {
    statusEl.textContent = 'Saving…';
    // File was streamed to disk chunk by chunk — just get the path
    const tmpPath = await window.api.saveTemp(null);
    if (!tmpPath) throw new Error('No temp file found');
    window.api.openEditor(tmpPath);
  } catch (e) {
    statusEl.textContent = `Save error: ${e.message}`;
    console.error('handleStop error:', e);
  }
}

async function captureSource(sourceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
  });
}
