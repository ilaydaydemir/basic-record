const canvas = document.getElementById('c');
const ctx    = canvas.getContext('2d');
const hint   = document.getElementById('hint');

canvas.width  = window.innerWidth;
canvas.height = window.innerHeight;

let drawing = false;
let sx = 0, sy = 0, ex = 0, ey = 0;

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Dark overlay
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!drawing) return;

  const x = Math.min(sx, ex), y = Math.min(sy, ey);
  const w = Math.abs(ex - sx),  h = Math.abs(ey - sy);

  // Cut out selected area (clear the dim)
  ctx.clearRect(x, y, w, h);

  // Border
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth   = 2;
  ctx.strokeRect(x, y, w, h);

  // Size label
  if (w > 60 && h > 30) {
    ctx.fillStyle = 'rgba(239,68,68,0.9)';
    const label = `${Math.round(w)} × ${Math.round(h)}`;
    ctx.font = 'bold 12px -apple-system, sans-serif';
    const tw = ctx.measureText(label).width + 12;
    ctx.fillRect(x, y - 22, tw, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 6, y - 7);
  }
}

canvas.addEventListener('mousedown', e => {
  drawing = true;
  sx = e.clientX; sy = e.clientY;
  ex = e.clientX; ey = e.clientY;
  hint.classList.add('hidden');
  draw();
});

canvas.addEventListener('mousemove', e => {
  if (!drawing) return;
  ex = e.clientX; ey = e.clientY;
  draw();
});

canvas.addEventListener('mouseup', () => {
  if (!drawing) return;
  drawing = false;
  const x = Math.min(sx, ex), y = Math.min(sy, ey);
  const w = Math.abs(ex - sx),  h = Math.abs(ey - sy);
  if (w < 10 || h < 10) { draw(); return; } // too small, redo
  window.api.regionSelected({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.api.regionSelected(null); // cancelled
});
