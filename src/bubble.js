'use strict';
const camVideo   = document.getElementById('cam-video');
const noCam      = document.getElementById('no-cam');
const timerEl    = document.getElementById('timer');
const camSection = document.getElementById('cam-section');
const camToggle  = document.getElementById('cam-toggle');
const camIcon    = document.getElementById('cam-icon');
const camText    = document.getElementById('cam-text');
const pauseBtn   = document.getElementById('pause-btn');
const stopBtn    = document.getElementById('stop-btn');
const discardBtn = document.getElementById('discard-btn');
const drawBtn    = document.getElementById('draw-btn');
const bubbleDrag = document.getElementById('bubble-drag');
const switchBtn  = document.getElementById('switch-btn');
const sourceNameEl = document.getElementById('source-name');

let camVisible = true;
let annotating = false;
let bubbleSize = 140;
let cameraFlipped = true; // mirrored by default

// ── Init ──────────────────────────────────────────────────
window.api.onInit(async ({ cameraDeviceId }) => {
  if (!cameraDeviceId) {
    noCam.style.display = 'flex';
    camIcon.textContent = '🚫';
    camText.textContent = 'No camera';
    camToggle.disabled = true;
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: cameraDeviceId }, width: 320, height: 320 },
    });
    camVideo.srcObject = stream;
    noCam.style.display = 'none';
    resizeWindow();
  } catch {
    noCam.style.display = 'flex';
    camIcon.textContent = '🚫';
    camText.textContent = 'Camera error';
  }
});

// ── Timer ─────────────────────────────────────────────────
window.api.onTimerTick(s => {
  const m = Math.floor(s / 60);
  timerEl.textContent = `${m}:${String(s % 60).padStart(2, '0')}`;
});

// ── Camera toggle ─────────────────────────────────────────
camToggle.addEventListener('click', () => {
  camVisible = !camVisible;
  camSection.classList.toggle('hidden', !camVisible);
  camText.textContent = camVisible ? 'Hide Camera' : 'Show Camera';
  camToggle.classList.toggle('cam-on', camVisible);
  window.api.setCamVisible(camVisible);
  setTimeout(resizeWindow, 350);
});

// ── Bubble size buttons ───────────────────────────────────
document.querySelectorAll('.btn-size').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-size').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    bubbleSize = +btn.dataset.size;
    setBubbleSize(bubbleSize);
  });
});

function setBubbleSize(size) {
  bubbleDrag.style.width  = size + 'px';
  bubbleDrag.style.height = size + 'px';
  const winW = size + 24;
  // S=80→0.10, M=140→0.18, L=200→0.26 of canvas min dimension
  const ratio = size / 140 * 0.18;
  window.api.setCamSize(ratio);
  setTimeout(() => {
    resizeWindow(winW);
  }, 50);
}

// ── Camera position ───────────────────────────────────────
let camPos = 'br';
document.querySelectorAll('.pos-btn').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.pos === camPos);
  btn.addEventListener('click', () => {
    camPos = btn.dataset.pos;
    document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    window.api.setCamPosition(camPos);
  });
});

// ── Flip camera ───────────────────────────────────────────
const flipBtn = document.getElementById('flip-btn');
flipBtn.addEventListener('click', () => {
  cameraFlipped = !cameraFlipped;
  camVideo.style.transform = cameraFlipped ? 'scaleX(-1)' : 'scaleX(1)';
  flipBtn.classList.toggle('flipped', !cameraFlipped);
  flipBtn.textContent = cameraFlipped ? '↔ Flip Camera' : '↔ Unflip Camera';
  window.api.flipCamera(cameraFlipped);
});

// ── Draw ──────────────────────────────────────────────────
drawBtn.addEventListener('click', () => {
  annotating = !annotating;
  drawBtn.classList.toggle('active', annotating);
  drawBtn.textContent = annotating ? '✏️ Done' : '✏️ Draw';
  window.api.toggleAnnotation();
});
window.api.onAnnotateClosed(() => {
  annotating = false;
  drawBtn.classList.remove('active');
  drawBtn.textContent = '✏️ Draw';
});

// ── Pause / resume ────────────────────────────────────────
let isPaused = false;
pauseBtn.addEventListener('click', () => {
  isPaused = !isPaused;
  window.api.pauseRecording(isPaused);
  pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
  pauseBtn.classList.toggle('paused', isPaused);
  // Show paused state on timer
  if (isPaused) {
    timerEl.style.opacity = '0.4';
  } else {
    timerEl.style.opacity = '1';
  }
});

// ── Stop / discard ────────────────────────────────────────
stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true;
  stopBtn.textContent = '…';
  window.api.stopRecording();
});
document.getElementById('restart-btn').addEventListener('click', () => {
  if (confirm('Restart recording? Current recording will be discarded.')) {
    window.api.restartRecording();
  }
});
discardBtn.addEventListener('click', () => {
  if (confirm('Discard this recording?')) window.api.discardRecording();
});
document.getElementById('cancel-btn').addEventListener('click', () => {
  window.api.discardRecording();
});

// ── Switch source ─────────────────────────────────────────
switchBtn.addEventListener('click', () => {
  window.api.openSourceSwitcher();
  switchBtn.classList.add('switching');
  switchBtn.textContent = '⇄ Switching…';
});

// Called by main when source is switched — passes source name
window.api.onSourceSwitched && window.api.onSourceSwitched(name => {
  switchBtn.classList.remove('switching');
  switchBtn.textContent = '⇄ Switch Source';

  // Flash source name
  const short = (name || 'New source').slice(0, 28);
  sourceNameEl.textContent = `● ${short}`;
  sourceNameEl.classList.add('flash');
  setTimeout(() => sourceNameEl.classList.remove('flash'), 2000);

  // Zıplama animasyonu
  bubbleDrag.classList.remove('jumping');
  void bubbleDrag.offsetWidth; // reflow to restart animation
  bubbleDrag.classList.add('jumping');
  setTimeout(() => bubbleDrag.classList.remove('jumping'), 550);
});

// ── Camera out-of-bounds indicator ───────────────────
window.api.onCamOutOfBounds(outOfBounds => {
  const bubble = document.getElementById('bubble-drag');
  bubble.classList.toggle('cam-out', outOfBounds);
});

// ── Drag bubble window ────────────────────────────────────
let dragging = false, ox = 0, oy = 0;
bubbleDrag.addEventListener('mousedown', e => {
  dragging = true; ox = e.screenX; oy = e.screenY;
  e.preventDefault();
});
window.addEventListener('mousemove', e => {
  if (!dragging) return;
  window.api.bubbleDrag({ dx: e.screenX - ox, dy: e.screenY - oy });
  ox = e.screenX; oy = e.screenY;
});
window.addEventListener('mouseup', () => { dragging = false; });

// ── Resize window ─────────────────────────────────────────
function resizeWindow(w) {
  const width = w || (bubbleSize + 24);
  const h = document.getElementById('panel').scrollHeight + 4;
  window.api.resizeBubble({ width, height: h });
}
setTimeout(resizeWindow, 400);
