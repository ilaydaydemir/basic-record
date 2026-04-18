const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

let tool   = 'pen';
let color  = '#ef4444';
let size   = 4;
let drawing= false;
let startX = 0, startY = 0;
let history= []; // snapshots for undo

function resize() {
  const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  ctx.putImageData(snap, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function saveHistory() {
  history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (history.length > 30) history.shift();
}

// ── Tool selection ─────────────────────────────────────────
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    tool = btn.id.replace('tool-', '');
    canvas.style.cursor = tool === 'blur' ? 'cell' : 'crosshair';
  });
});

// ── Color ─────────────────────────────────────────────────
document.querySelectorAll('.swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
    color = sw.dataset.color;
  });
});

// ── Size ─────────────────────────────────────────────────
document.getElementById('size-slider').addEventListener('input', e => {
  size = parseInt(e.target.value);
});

// ── Undo / Clear ─────────────────────────────────────────
document.getElementById('undo-btn').addEventListener('click', () => {
  if (history.length === 0) return;
  ctx.putImageData(history.pop(), 0, 0);
  sendToRecorder();
});

document.getElementById('clear-btn').addEventListener('click', () => {
  saveHistory();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  sendToRecorder();
});

// ── Close → tell main to hide annotation window ───────────
document.getElementById('close-btn').addEventListener('click', () => {
  window.api.toggleAnnotation();
});

// ── Drawing ───────────────────────────────────────────────
canvas.addEventListener('mousedown', e => {
  if (e.target.closest('.toolbar')) return;
  drawing = true;
  startX = e.clientX;
  startY = e.clientY;
  saveHistory();

  if (tool === 'pen') {
    ctx.beginPath();
    ctx.moveTo(startX, startY);
  }
});

canvas.addEventListener('mousemove', e => {
  if (!drawing) return;
  const x = e.clientX, y = e.clientY;

  if (tool === 'pen') {
    ctx.lineWidth   = size;
    ctx.strokeStyle = color;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.lineTo(x, y);
    ctx.stroke();
    return;
  }

  // For shape tools: redraw from snapshot on every move
  const snap = history[history.length - 1];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (snap) ctx.putImageData(snap, 0, 0);

  ctx.strokeStyle = color;
  ctx.lineWidth   = size;
  ctx.lineCap     = 'round';

  if (tool === 'arrow') {
    drawArrow(ctx, startX, startY, x, y);
  } else if (tool === 'rect') {
    ctx.strokeRect(startX, startY, x - startX, y - startY);
  } else if (tool === 'blur') {
    // Draw blur placeholder rect
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.01)';
    ctx.fillRect(startX, startY, x - startX, y - startY);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(startX, startY, x - startX, y - startY);
    ctx.setLineDash([]);
    ctx.restore();
  }
});

canvas.addEventListener('mouseup', e => {
  if (!drawing) return;
  drawing = false;

  if (tool === 'blur') {
    const x1 = Math.min(startX, e.clientX);
    const y1 = Math.min(startY, e.clientY);
    const w  = Math.abs(e.clientX - startX);
    const h  = Math.abs(e.clientY - startY);
    applyBlur(x1, y1, w, h);
  }

  // Send current annotation canvas to recorder so it appears in the video
  sendToRecorder();
});

function sendToRecorder() {
  try {
    const dataUrl = canvas.toDataURL('image/png');
    window.api.sendAnnotationFrame(dataUrl);
  } catch {}
}

// ── Blur implementation ───────────────────────────────────
function applyBlur(x, y, w, h) {
  if (w < 4 || h < 4) return;
  // Extract region → scale down → scale up (pixelate effect)
  const off = document.createElement('canvas');
  off.width  = w; off.height = h;
  const octx = off.getContext('2d');
  octx.drawImage(canvas, x, y, w, h, 0, 0, w, h);

  // Pixelate by scaling
  const factor = 12;
  const small = document.createElement('canvas');
  small.width  = Math.max(1, Math.floor(w / factor));
  small.height = Math.max(1, Math.floor(h / factor));
  const sctx = small.getContext('2d');
  sctx.drawImage(off, 0, 0, small.width, small.height);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.imageSmoothingEnabled = true;
}

// ── Arrow helper ──────────────────────────────────────────
function drawArrow(ctx, x1, y1, x2, y2) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(16, ctx.lineWidth * 4);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}
