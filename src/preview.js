'use strict';
const vid   = document.getElementById('preview-video');
const timer = document.getElementById('timer');

window.api.onStart(async ({ sourceId }) => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
    });
    vid.srcObject = stream;
  } catch (e) {
    console.warn('Preview stream failed:', e.message);
  }
});

window.api.onTimerTick(s => {
  const m = Math.floor(s / 60);
  timer.textContent = `${m}:${String(s % 60).padStart(2, '0')}`;
});

window.api.onStop(() => {
  vid.srcObject?.getTracks().forEach(t => t.stop());
});
window.api.onDiscard(() => {
  vid.srcObject?.getTracks().forEach(t => t.stop());
});
