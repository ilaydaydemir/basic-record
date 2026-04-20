'use strict';

// ── Elements ──────────────────────────────────────────────
const video        = document.getElementById('video');
const canvas       = document.getElementById('preview-canvas');
const ctx          = canvas.getContext('2d');
const tlCanvas     = document.getElementById('timeline');
const tctx         = tlCanvas.getContext('2d');
const timeInd      = document.getElementById('time-indicator');
const timeDisp     = document.getElementById('time-display');
const playBtn      = document.getElementById('play-btn');
const exportStatus = document.getElementById('export-status');
const cropOverlay  = document.getElementById('crop-overlay');

// ── State ─────────────────────────────────────────────────
let duration    = 0;
let trimIn      = 0;
let trimOut     = 0;
let cuts        = [];
let annotations = [];
let _history    = [];   // unified undo: [{annotations, cuts}]
let _redo       = [];
let annHistory  = [];   // annotation-only undo (used internally)
let annRedo     = [];
let activeTool  = 'none';
let activeColor = '#ef4444';
let brushSize   = 5;
let isDrawing   = false;
let currentStroke = null;
let cropRect    = null;
let cropStart   = null;
let isCropping  = false;
let isDraggingPlayhead = false;
let _skippingCut = false;
let speed = 1;

// ── Subtitle state ────────────────────────────────────────
let subtitleSegments = [];
let subtitleCuts     = new Set();
let subtitleBg       = 'rgba(0,0,0,0.78)';
let subtitleTxtCol   = '#ffffff';
let subtitleFontSize = 22;
let subtitlePos      = { x: 0.5, y: 0.88 }; // normalized center position
let _subBBox         = null;                  // last drawn subtitle bounding box
let _subDragging     = false;
let _subResizing     = false;
let _subResizeStartY = 0;
let _subResizeStartSize = 22;
let currentFilePath  = null;
let _whisperPipe     = null;
let _autoUploadedStoragePath = null; // set when autoUpload succeeds; prevents duplicate DB row on manual upload
let _autoUploadInProgress = false;   // guard against duplicate concurrent autoUploads

// ── Load video ────────────────────────────────────────────
window.api.onLoadVideo(fp => {
  currentFilePath = fp;
  _autoUploadedStoragePath = null; // reset on every new video
  video.src = `file://${fp}`;
  video.load();
  // Start background upload if session exists
  autoUpload();
});

video.addEventListener('loadedmetadata', () => {
  // MediaRecorder webm files often have no duration in header
  if (!isFinite(video.duration) || video.duration < 0.1) {
    video.currentTime = 1e101; // browser clamps to actual end
    video.addEventListener('seeked', function fixDuration() {
      duration = video.duration;
      trimIn   = 0;
      trimOut  = duration;
      video.currentTime = 0;
      video.removeEventListener('seeked', fixDuration);
      resizeCanvases();
      drawTimeline();
      updateTimeDisplay();
    });
  } else {
    duration = video.duration;
    trimIn   = 0;
    trimOut  = duration;
    resizeCanvases();
    drawTimeline();
    updateTimeDisplay();
  }
});

video.addEventListener('timeupdate', () => {
  if (_skippingCut) return;

  // Skip over cut sections during playback
  if (!video.paused && cuts.length) {
    const t = video.currentTime;
    const hit = cuts.find(c => t >= c.start && t < c.end);
    if (hit) {
      _skippingCut = true;
      video.currentTime = hit.end >= duration ? duration : hit.end;
      setTimeout(() => { _skippingCut = false; }, 80);
      return;
    }
  }

  if (video.currentTime >= trimOut) {
    video.pause();
    video.currentTime = trimOut;
    playBtn.textContent = '▶ Play';
  }
  updateTimeDisplay();
  drawTimeline();
  redrawAnnotations();
  // Auto-scroll transcript and highlight current segment
  if (subtitleSegments.length) {
    const t = video.currentTime;
    const activeSeg = subtitleSegments.find((s, i) => {
      const next = subtitleSegments[i + 1];
      return t >= s.start && (!next || t < next.start);
    });
    const container = document.getElementById('subtitle-segments');
    container.querySelectorAll('.sub-seg').forEach(el => {
      const isActive = activeSeg && el.dataset.segId === String(activeSeg.id);
      el.classList.toggle('playing', isActive);
    });
    if (activeSeg && !video.paused) {
      const el = container.querySelector(`[data-seg-id="${activeSeg.id}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  highlightCurrentSubSegment();
});
video.addEventListener('ended', () => { playBtn.textContent = '▶ Play'; });

// ── Resize ────────────────────────────────────────────────
function resizeCanvases() {
  const area = document.getElementById('preview-area');
  canvas.width  = area.clientWidth;
  canvas.height = area.clientHeight;
  tlCanvas.width  = tlCanvas.parentElement.clientWidth;
  tlCanvas.height = tlCanvas.parentElement.clientHeight;
  redrawAnnotations();
  drawTimeline();
}
window.addEventListener('resize', resizeCanvases);
setTimeout(resizeCanvases, 150);

// ── Time helpers ──────────────────────────────────────────
function fmt(s) {
  if (!isFinite(s) || s < 0) return '0:00.0';
  const m   = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}
function updateTimeDisplay() {
  const t = `${fmt(video.currentTime)} / ${fmt(duration)}`;
  timeInd.textContent  = t;
  timeDisp.textContent = t;
}

// ── Playback ──────────────────────────────────────────────
playBtn.addEventListener('click', () => {
  if (video.paused) {
    if (video.currentTime >= trimOut - 0.05) video.currentTime = trimIn;
    video.play();
    playBtn.textContent = '⏸ Pause';
  } else {
    video.pause();
    playBtn.textContent = '▶ Play';
  }
});

// ── Trim / cut ────────────────────────────────────────────
document.getElementById('mark-in-btn').addEventListener('click', () => {
  if (!selectMode) { selectMode = true; selectModeBtn.classList.add('active'); selectModeBtn.textContent = '⬚ Select ✓'; }
  trimIn = video.currentTime;
  if (trimIn >= trimOut) trimOut = duration;
  drawTimeline();
});
document.getElementById('mark-out-btn').addEventListener('click', () => {
  if (!selectMode) { selectMode = true; selectModeBtn.classList.add('active'); selectModeBtn.textContent = '⬚ Select ✓'; }
  trimOut = video.currentTime;
  if (trimOut <= trimIn) trimIn = 0;
  drawTimeline();
});
document.getElementById('cut-btn').addEventListener('click', () => {
  if (trimIn >= trimOut) return;
  saveState();
  cuts.push({ start: trimIn, end: trimOut });
  cuts.sort((a, b) => a.start - b.start);
  trimIn = 0; trimOut = duration;
  drawTimeline(); renderCutsList();
});
document.getElementById('reset-trim-btn').addEventListener('click', () => {
  saveState();
  trimIn = 0; trimOut = duration; cuts = [];
  subtitleCuts = new Set();
  drawTimeline(); renderCutsList(); renderSubtitleList();
});

// ── Timeline ──────────────────────────────────────────────
function drawTimeline() {
  const W = tlCanvas.width, H = tlCanvas.height;
  tctx.clearRect(0, 0, W, H);

  // Track background
  tctx.fillStyle = '#222';
  tctx.roundRect(0, H/2 - 6, W, 12, 4);
  tctx.fill();

  if (!duration) return;
  const tx = t => (t / duration) * W;

  // Selection region (blue highlight) — only in select mode
  if (selectMode && (trimIn > 0 || trimOut < duration)) {
    tctx.fillStyle = 'rgba(96,165,250,0.22)';
    tctx.fillRect(tx(trimIn), 0, tx(trimOut) - tx(trimIn), H);
    tctx.fillStyle = 'rgba(96,165,250,0.7)';
    tctx.fillRect(tx(trimIn), H/2 - 6, tx(trimOut) - tx(trimIn), 12);
  }

  // Cut regions with draggable edge handles
  cuts.forEach(c => {
    const cx = tx(c.start), cw = tx(c.end) - tx(c.start);
    tctx.fillStyle = 'rgba(239,68,68,0.12)';
    tctx.fillRect(cx, 0, cw, H);
    tctx.fillStyle = 'rgba(239,68,68,0.5)';
    tctx.fillRect(cx, H/2 - 5, cw, 10);
    // Edge handles (draggable)
    [cx, cx + cw].forEach(hx => {
      tctx.fillStyle = '#ef4444';
      tctx.fillRect(hx - 3, 0, 6, H);
      tctx.fillStyle = '#fff';
      tctx.beginPath();
      tctx.arc(hx, H / 2, 5, 0, Math.PI * 2);
      tctx.fill();
    });
  });

  // Trim handles — only in select mode
  if (selectMode && (trimIn > 0 || trimOut < duration)) {
    [trimIn, trimOut].forEach(t => {
      tctx.fillStyle = '#fff';
      tctx.fillRect(tx(t) - 2, 0, 4, H);
    });
  }

  // Annotation time range bars + start markers
  annotations.forEach(a => {
    const sx = tx(a.time);
    const ex = tx(Math.min(a.endTime ?? duration, duration));
    tctx.fillStyle = (a.color || '#facc15') + '44';
    tctx.fillRect(sx, H - 10, ex - sx, 5);
    tctx.fillStyle = a.color || '#facc15';
    tctx.fillRect(sx - 1, H - 10, 2, 5);
  });

  // Playhead
  const px = tx(video.currentTime || 0);
  tctx.fillStyle = '#ef4444';
  tctx.fillRect(px - 1, 0, 2, H);
  // Playhead circle
  tctx.beginPath();
  tctx.arc(px, H / 2, 6, 0, Math.PI * 2);
  tctx.fill();
}

// ── Select mode ───────────────────────────────────────────
let selectMode = false;
const selectModeBtn = document.getElementById('select-mode-btn');
selectModeBtn.addEventListener('click', () => {
  selectMode = !selectMode;
  selectModeBtn.classList.toggle('active', selectMode);
  selectModeBtn.textContent = selectMode ? '⬚ Select ✓' : '⬚ Select';
  if (!selectMode) {
    trimIn = 0; trimOut = duration;
    drawTimeline();
  }
});

// ── Timeline interaction: drag = select range (only in selectMode), click = seek ──
let _tlDragStartX  = null;
let _tlDragStartPct = null;
let _tlIsDragging  = false;

function tlPct(e) {
  const r = tlCanvas.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}

let _edgeDrag = null; // { cutIdx, edge: 'start'|'end' }

tlCanvas.addEventListener('mousemove', e => {
  if (isDraggingPlayhead || _edgeDrag) return;
  if (!duration || !cuts.length) { tlCanvas.style.cursor = 'pointer'; return; }
  const r   = tlCanvas.getBoundingClientRect();
  const px  = e.clientX - r.left;
  const W   = r.width;
  const SNAP = 8; // px hit area for edge handles
  let onEdge = false;
  cuts.forEach(c => {
    const sx = (c.start / duration) * W;
    const ex = (c.end   / duration) * W;
    if (Math.abs(px - sx) <= SNAP || Math.abs(px - ex) <= SNAP) onEdge = true;
  });
  tlCanvas.style.cursor = onEdge ? 'ew-resize' : 'pointer';
});

tlCanvas.addEventListener('mousedown', e => {
  if (!duration) return;
  const r   = tlCanvas.getBoundingClientRect();
  const px  = e.clientX - r.left;
  const W   = r.width;
  const SNAP = 8;

  // Check if clicking near a cut edge
  for (let i = 0; i < cuts.length; i++) {
    const sx = (cuts[i].start / duration) * W;
    const ex = (cuts[i].end   / duration) * W;
    if (Math.abs(px - sx) <= SNAP) { _edgeDrag = { cutIdx: i, edge: 'start' }; e.preventDefault(); return; }
    if (Math.abs(px - ex) <= SNAP) { _edgeDrag = { cutIdx: i, edge: 'end'   }; e.preventDefault(); return; }
  }

  _tlDragStartX   = e.clientX;
  _tlDragStartPct = tlPct(e);
  _tlIsDragging   = false;
  isDraggingPlayhead = true;
});

window.addEventListener('mousemove', e => {
  // Edge drag: adjust cut boundary
  if (_edgeDrag && duration) {
    const t = Math.max(0, Math.min(duration, tlPct(e) * duration));
    const c = cuts[_edgeDrag.cutIdx];
    if (_edgeDrag.edge === 'start') c.start = Math.min(t, c.end - 0.05);
    else                            c.end   = Math.max(t, c.start + 0.05);
    drawTimeline(); renderCutsList(); renderSubtitleList();
    return;
  }

  if (!isDraggingPlayhead || !duration) return;
  const dx = Math.abs(e.clientX - _tlDragStartX);
  if (dx > 4 && selectMode) {
    _tlIsDragging = true;
    const curPct = tlPct(e);
    trimIn  = Math.min(_tlDragStartPct, curPct) * duration;
    trimOut = Math.max(_tlDragStartPct, curPct) * duration;
    drawTimeline();
    tlCanvas.style.cursor = 'col-resize';
  } else if (dx > 4 && !selectMode) {
    // seek playhead while dragging
    video.currentTime = tlPct(e) * duration;
    drawTimeline();
  }
});

window.addEventListener('mouseup', e => {
  if (_edgeDrag) { _edgeDrag = null; tlCanvas.style.cursor = 'pointer'; return; }
  if (!isDraggingPlayhead) return;
  isDraggingPlayhead = false;
  tlCanvas.style.cursor = 'pointer';

  if (_tlIsDragging) {
    _tlIsDragging = false;
    drawTimeline();
  } else {
    video.currentTime = tlPct(e) * duration;
    drawTimeline();
  }
  _tlDragStartX = _tlDragStartPct = null;
});

// ── Draw tools ────────────────────────────────────────────
document.querySelectorAll('[id^="tool-"]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[id^="tool-"]').forEach(x => x.classList.remove('active'));
    activeTool = b.id.replace('tool-', '');
    if (activeTool !== 'none') b.classList.add('active');
    canvas.classList.toggle('drawing', activeTool !== 'none');
    isCropping = false;
    cropOverlay.classList.remove('active');
    // Show/hide text input panel
    const wrap = document.getElementById('text-input-wrap');
    wrap.style.display = activeTool === 'text' ? 'flex' : 'none';
    if (activeTool === 'text') document.getElementById('sidebar-text-input').focus();
  });
});

document.querySelectorAll('.color-swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
    activeColor = sw.dataset.color;
  });
});

const brushSlider = document.getElementById('brush-size');
const brushValEl  = document.getElementById('brush-val');
brushSlider.addEventListener('input', () => {
  brushSize = +brushSlider.value;
  brushValEl.textContent = brushSize;
});

// Canvas mouse events
canvas.addEventListener('mousedown', e => {
  if (activeTool === 'none') return;
  e.preventDefault();
  isDrawing = true;
  const p = canvasPoint(e);
  if (activeTool === 'pen') {
    currentStroke = { tool: 'pen', color: activeColor, size: brushSize, points: [p], time: video.currentTime };
  } else if (activeTool === 'blur') {
    currentStroke = { tool: 'blur', size: brushSize, points: [p], time: video.currentTime };
  } else if (activeTool === 'arrow' || activeTool === 'rect') {
    currentStroke = { tool: activeTool, color: activeColor, size: brushSize, start: { ...p }, end: { ...p }, time: video.currentTime };
  } else if (activeTool === 'text') {
    isDrawing = false;
    const txt = document.getElementById('sidebar-text-input').value.trim()
      || fmt(video.currentTime); // fallback to timestamp if empty
    if (txt) saveAnnotation({ tool: 'text', color: activeColor, size: brushSize, pos: { ...p }, text: txt, time: video.currentTime });
  }
});
canvas.addEventListener('mousemove', e => {
  if (!isDrawing || !currentStroke) return;
  const p = canvasPoint(e);
  if (currentStroke.tool === 'pen' || currentStroke.tool === 'blur') {
    currentStroke.points.push(p);
  } else {
    currentStroke.end = { ...p };
  }
  redrawAnnotations();
});
canvas.addEventListener('mouseup', () => {
  if (!isDrawing || !currentStroke) return;
  isDrawing = false;
  saveAnnotation(currentStroke);
  currentStroke = null;
});

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}


// ── Annotations ───────────────────────────────────────────
function saveAnnotation(ann) {
  saveState();
  annotations.push({ ...ann, id: Date.now(), endTime: duration || 9999 });
  redrawAnnotations();
  drawTimeline();
  renderAnnList();
}

function redrawAnnotations() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const t = video.currentTime || 0;
  annotations.filter(a => a.time <= t && t < (a.endTime ?? 9999)).forEach(a => drawAnnotation(ctx, a, W, H));
  if (currentStroke) drawAnnotation(ctx, currentStroke, W, H);
  drawSubtitleOverlay(ctx, W, H, t);
}

function drawAnnotation(c, a, W, H) {
  if (!a || !a.tool) return;
  c.save();
  c.strokeStyle = a.color || '#ef4444';
  c.fillStyle   = a.color || '#ef4444';
  c.lineWidth   = a.size  || 5;
  c.lineCap     = 'round';
  c.lineJoin    = 'round';

  if (a.tool === 'pen') {
    if (!a.points?.length) { c.restore(); return; }
    c.beginPath();
    a.points.forEach((p, i) =>
      i === 0 ? c.moveTo(p.x * W, p.y * H) : c.lineTo(p.x * W, p.y * H)
    );
    c.stroke();

  } else if (a.tool === 'blur') {
    if (!a.points?.length) { c.restore(); return; }
    const r = Math.max(3, a.size || 5); // thin line radius
    c.save();
    c.filter = `blur(${r * 1.5}px)`;
    c.fillStyle = 'rgba(0,0,0,1)';
    c.beginPath();
    a.points.forEach((p, i) =>
      i === 0 ? c.moveTo(p.x * W, p.y * H) : c.lineTo(p.x * W, p.y * H)
    );
    c.lineWidth   = r * 2;
    c.strokeStyle = 'rgba(0,0,0,1)';
    c.lineCap = 'round';
    c.stroke();
    c.restore();

  } else if (a.tool === 'arrow') {
    if (!a.start || !a.end) { c.restore(); return; }
    const x1 = a.start.x * W, y1 = a.start.y * H;
    const x2 = a.end.x   * W, y2 = a.end.y   * H;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const hs  = (a.size || 5) * 3;
    c.beginPath();
    c.moveTo(x2, y2);
    c.lineTo(x2 - hs * Math.cos(ang - 0.4), y2 - hs * Math.sin(ang - 0.4));
    c.lineTo(x2 - hs * Math.cos(ang + 0.4), y2 - hs * Math.sin(ang + 0.4));
    c.closePath(); c.fill();

  } else if (a.tool === 'rect') {
    if (!a.start || !a.end) { c.restore(); return; }
    c.strokeRect(
      Math.min(a.start.x, a.end.x) * W,
      Math.min(a.start.y, a.end.y) * H,
      Math.abs(a.end.x - a.start.x) * W,
      Math.abs(a.end.y - a.start.y) * H
    );

  } else if (a.tool === 'text') {
    if (!a.pos) { c.restore(); return; }
    c.font = `bold ${(a.size || 5) * 4}px -apple-system, sans-serif`;
    c.fillText(a.text, a.pos.x * W, a.pos.y * H);
  }
  c.restore();
}

// ── Unified state save/restore ────────────────────────────
const MAX_HISTORY = 50;
function saveState() {
  _history.push({ annotations: JSON.parse(JSON.stringify(annotations)), cuts: JSON.parse(JSON.stringify(cuts)), subtitleCuts: [...subtitleCuts] });
  if (_history.length > MAX_HISTORY) _history.shift();
  _redo = [];
  annHistory.push(JSON.parse(JSON.stringify(annotations)));
  if (annHistory.length > MAX_HISTORY) annHistory.shift();
  annRedo = [];
}

// ── Undo / Redo ───────────────────────────────────────────
document.getElementById('undo-btn').addEventListener('click', () => {
  if (!_history.length) return;
  _redo.push({ annotations: JSON.parse(JSON.stringify(annotations)), cuts: JSON.parse(JSON.stringify(cuts)), subtitleCuts: [...subtitleCuts] });
  const prev = _history.pop();
  annotations = prev.annotations;
  cuts = prev.cuts;
  subtitleCuts = new Set(prev.subtitleCuts);
  redrawAnnotations(); drawTimeline(); renderAnnList(); renderCutsList(); renderSubtitleList();
});
document.getElementById('redo-btn').addEventListener('click', () => {
  if (!_redo.length) return;
  _history.push({ annotations: JSON.parse(JSON.stringify(annotations)), cuts: JSON.parse(JSON.stringify(cuts)), subtitleCuts: [...subtitleCuts] });
  const next = _redo.pop();
  annotations = next.annotations;
  cuts = next.cuts;
  subtitleCuts = new Set(next.subtitleCuts);
  redrawAnnotations(); drawTimeline(); renderAnnList(); renderCutsList(); renderSubtitleList();
});

// ── Parse typed time string → seconds ────────────────────
function parseTime(str) {
  str = str.trim();
  // formats: "1:23.4", "1:23", "83.4", "83"
  const m = str.match(/^(\d+):(\d+(?:\.\d+)?)$/) || str.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  if (str.includes(':')) {
    return parseFloat(m[1]) * 60 + parseFloat(m[2]);
  }
  return parseFloat(str);
}

// ── Annotation list ───────────────────────────────────────
function renderAnnList() {
  const list  = document.getElementById('ann-list');
  const count = document.getElementById('ann-count');
  count.textContent = annotations.length;
  list.innerHTML = '';
  annotations.forEach((a, i) => {
    const endLabel = (a.endTime != null && a.endTime < 9000) ? fmt(a.endTime) : 'end';
    const el = document.createElement('div');
    el.className = 'ann-item';
    el.innerHTML = `
      <span class="ann-item-time" title="Click: seek+play  Double-click: edit start time">${fmt(a.time)}</span>
      <span class="ann-arrow">→</span>
      <span class="ann-item-end" title="Click: set to playhead  Double-click: edit end time">${endLabel}</span>
      <span class="ann-item-type">${a.tool}</span>
      <button class="ann-del" data-i="${i}">✕</button>`;

    // Single click start → seek + play
    el.querySelector('.ann-item-time').addEventListener('click', () => {
      video.currentTime = a.time;
      video.play();
      playBtn.textContent = '⏸ Pause';
    });

    // Double-click start → inline edit
    el.querySelector('.ann-item-time').addEventListener('dblclick', e => {
      e.stopPropagation();
      openTimeEdit(el.querySelector('.ann-item-time'), a.time, val => {
        const t = parseTime(val);
        if (t !== null && t >= 0) { annotations[i].time = t; redrawAnnotations(); drawTimeline(); renderAnnList(); }
      });
    });

    // Single click end → set to current playhead
    el.querySelector('.ann-item-end').addEventListener('click', () => {
      const t = video.currentTime;
      if (t > a.time) { annotations[i].endTime = t; redrawAnnotations(); drawTimeline(); renderAnnList(); }
    });

    // Double-click end → inline edit
    el.querySelector('.ann-item-end').addEventListener('dblclick', e => {
      e.stopPropagation();
      const cur = (a.endTime != null && a.endTime < 9000) ? fmt(a.endTime) : '';
      openTimeEdit(el.querySelector('.ann-item-end'), cur, val => {
        if (val === '' || val.toLowerCase() === 'end') { annotations[i].endTime = 9999; }
        else { const t = parseTime(val); if (t !== null && t > a.time) annotations[i].endTime = t; }
        redrawAnnotations(); drawTimeline(); renderAnnList();
      });
    });

    el.querySelector('.ann-del').addEventListener('click', () => {
      annHistory.push(JSON.parse(JSON.stringify(annotations)));
      annotations.splice(i, 1);
      redrawAnnotations(); drawTimeline(); renderAnnList();
    });
    list.appendChild(el);
  });
}

// ── Inline time editor ────────────────────────────────────
function openTimeEdit(spanEl, currentVal, onCommit) {
  const input = document.createElement('input');
  input.type  = 'text';
  input.value = typeof currentVal === 'number' ? fmt(currentVal) : (currentVal || '');
  input.style.cssText = `width:54px; background:#111; color:#fff; border:1px solid #60a5fa;
    border-radius:4px; padding:1px 4px; font-size:11px; font-variant-numeric:tabular-nums;`;
  spanEl.replaceWith(input);
  input.select();
  input.focus();
  const done = () => { onCommit(input.value); };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); done(); }
    if (e.key === 'Escape') renderAnnList();
  });
  input.addEventListener('blur', done);
}

// ── Cuts list (chips) ─────────────────────────────────────
function renderCutsList() {
  const bar   = document.getElementById('cuts-bar');
  const chips = document.getElementById('cuts-chips');
  chips.innerHTML = '';
  if (!cuts.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  [...cuts].sort((a, b) => a.start - b.start).forEach((c, i) => {
    const chip = document.createElement('span');
    chip.className = 'cut-chip';
    chip.innerHTML = `${fmt(c.start)} → ${fmt(c.end)} <button title="Restore this cut">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      cuts = cuts.filter((_, j) => j !== cuts.indexOf(c));
      // also remove from subtitle cuts if matching
      subtitleSegments.forEach(s => {
        if (Math.abs(s.start - c.start) < 0.05 && Math.abs(s.end - c.end) < 0.05)
          subtitleCuts.delete(s.id);
      });
      drawTimeline(); renderCutsList(); renderSubtitleList();
    });
    chips.appendChild(chip);
  });
}

// ── Crop ──────────────────────────────────────────────────
let cropBox = null; // visual div

document.getElementById('crop-btn').addEventListener('click', () => {
  isCropping = true;
  cropOverlay.classList.add('active');
  document.querySelectorAll('[id^="tool-"]').forEach(x => x.classList.remove('active'));
  activeTool = 'none';
  canvas.classList.remove('drawing');
});
document.getElementById('crop-clear-btn').addEventListener('click', () => {
  cropRect = null;
  document.getElementById('crop-info').textContent = 'No crop set';
  cropOverlay.classList.remove('active');
  if (cropBox) { cropBox.remove(); cropBox = null; }
  isCropping = false;
});

cropOverlay.addEventListener('mousedown', e => {
  if (!isCropping) return;
  e.preventDefault();
  const r = cropOverlay.getBoundingClientRect();
  cropStart = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (!cropBox) {
    cropBox = document.createElement('div');
    cropBox.style.cssText = 'position:absolute;border:2px solid #ef4444;background:rgba(239,68,68,0.08);pointer-events:none;';
    cropOverlay.appendChild(cropBox);
  }
});
cropOverlay.addEventListener('mousemove', e => {
  if (!cropStart || !cropBox) return;
  const r  = cropOverlay.getBoundingClientRect();
  const x2 = e.clientX - r.left, y2 = e.clientY - r.top;
  cropBox.style.left   = Math.min(cropStart.x, x2) + 'px';
  cropBox.style.top    = Math.min(cropStart.y, y2) + 'px';
  cropBox.style.width  = Math.abs(x2 - cropStart.x) + 'px';
  cropBox.style.height = Math.abs(y2 - cropStart.y) + 'px';
});
cropOverlay.addEventListener('mouseup', e => {
  if (!cropStart) return;
  const r  = cropOverlay.getBoundingClientRect();
  const x2 = e.clientX - r.left, y2 = e.clientY - r.top;
  const rw = Math.abs(x2 - cropStart.x) / r.width;
  const rh = Math.abs(y2 - cropStart.y) / r.height;
  if (rw > 0.02 && rh > 0.02) {
    cropRect = {
      x: Math.min(cropStart.x, x2) / r.width,
      y: Math.min(cropStart.y, y2) / r.height,
      w: rw, h: rh,
    };
    document.getElementById('crop-info').textContent =
      `${Math.round(rw * 100)}% × ${Math.round(rh * 100)}%`;
  }
  cropStart  = null;
  isCropping = false;
  cropOverlay.classList.remove('active');
});

// ── Export platform presets ────────────────────────────────
const PLATFORM_PRESETS = [
  { id: 'original',     name: 'Original',           icon: '⬛', res: 'Keep source size',     w: null,  h: null  },
  { id: 'linkedin',     name: 'LinkedIn',            icon: '💼', res: '1920 × 1080  (16:9)', w: 1920,  h: 1080  },
  { id: 'youtube',      name: 'YouTube',             icon: '▶',  res: '1920 × 1080  (16:9)', w: 1920,  h: 1080  },
  { id: 'twitter',      name: 'Twitter / X',         icon: '𝕏',  res: '1280 × 720   (16:9)', w: 1280,  h: 720   },
  { id: 'insta-sq',     name: 'Instagram Square',    icon: '◼',  res: '1080 × 1080   (1:1)', w: 1080,  h: 1080  },
  { id: 'insta-story',  name: 'Instagram / TikTok',  icon: '📱', res: '1080 × 1920   (9:16)', w: 1080,  h: 1920  },
];

// Build platform grid
const platformGrid = document.getElementById('platform-grid');
PLATFORM_PRESETS.forEach(p => {
  const card = document.createElement('div');
  card.className = 'platform-card';
  card.innerHTML = `<div class="platform-card-icon">${p.icon}</div>
    <div class="platform-card-name">${p.name}</div>
    <div class="platform-card-res">${p.res}</div>`;
  card.addEventListener('click', () => runExport(p));
  platformGrid.appendChild(card);
});

document.getElementById('export-btn').addEventListener('click', () => {
  document.getElementById('export-modal').style.display = 'flex';
  document.getElementById('export-modal-status').textContent = '';
});
document.getElementById('export-modal-close').addEventListener('click', () => {
  document.getElementById('export-modal').style.display = 'none';
});

// ── Helper: compute center-crop src rect to match target AR ──
function cropToAspect(srcW, srcH, tgtW, tgtH) {
  const srcAR = srcW / srcH;
  const tgtAR = tgtW / tgtH;
  let sx, sy, sw, sh;
  if (srcAR > tgtAR) {
    sh = srcH; sw = srcH * tgtAR; sx = (srcW - sw) / 2; sy = 0;
  } else {
    sw = srcW; sh = srcW / tgtAR; sx = 0; sy = (srcH - sh) / 2;
  }
  return { sx, sy, sw, sh };
}

// ── Core export function ──────────────────────────────────
async function runExport(preset) {
  const modalStatus = document.getElementById('export-modal-status');
  modalStatus.textContent = 'Choose save location…';

  const savePath = await window.api.getSavePath();
  if (!savePath) { modalStatus.textContent = ''; return; }

  document.getElementById('export-modal').style.display = 'none';
  exportStatus.textContent = 'Encoding…';

  // Build keep ranges from trim + cuts
  let keepRanges = [];
  let cursor = trimIn;
  [...cuts].sort((a, b) => a.start - b.start).forEach(c => {
    if (cursor < c.start) keepRanges.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  });
  if (cursor < trimOut) keepRanges.push({ start: cursor, end: trimOut });
  if (!keepRanges.length) keepRanges = [{ start: trimIn, end: trimOut }];

  const vW = video.videoWidth  || 1280;
  const vH = video.videoHeight || 720;

  let outW, outH, srcX, srcY, srcW, srcH;

  if (preset.w && preset.h) {
    // Platform preset: center-crop to target AR, scale to target resolution
    outW = preset.w; outH = preset.h;
    const cr = cropToAspect(vW, vH, outW, outH);
    srcX = cr.sx; srcY = cr.sy; srcW = cr.sw; srcH = cr.sh;
  } else {
    // Original: apply manual cropRect if set
    if (cropRect) {
      const previewArea = document.getElementById('preview-area');
      const aW = previewArea.clientWidth, aH = previewArea.clientHeight;
      const scale = Math.min(aW / vW, aH / vH);
      const dispW = vW * scale, dispH = vH * scale;
      const offX  = (aW - dispW) / 2, offY = (aH - dispH) / 2;
      srcX = Math.max(0, (cropRect.x * aW - offX) / scale);
      srcY = Math.max(0, (cropRect.y * aH - offY) / scale);
      srcW = Math.min(vW - srcX, cropRect.w * aW / scale);
      srcH = Math.min(vH - srcY, cropRect.h * aH / scale);
      outW = Math.round(srcW); outH = Math.round(srcH);
    } else {
      srcX = 0; srcY = 0; srcW = vW; srcH = vH; outW = vW; outH = vH;
    }
  }

  const offCanvas = document.createElement('canvas');
  offCanvas.width = outW; offCanvas.height = outH;
  const oc = offCanvas.getContext('2d');

  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
  const stream = offCanvas.captureStream(30);
  const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });

  // Stream chunks directly to disk — zero RAM accumulation
  await window.api.exportStreamOpen(savePath);
  let _writeQueue = Promise.resolve();
  mr.ondataavailable = e => {
    if (e.data.size === 0) return;
    _writeQueue = _writeQueue.then(async () => {
      const ab = await e.data.arrayBuffer();
      await window.api.exportStreamWrite(ab);
    });
  };
  mr.start(200);

  const totalDur = keepRanges.reduce((s, r) => s + r.end - r.start, 0);
  let elapsed = 0;

  try {
    for (const range of keepRanges) {
      video.currentTime = range.start;
      // Seek with 8s timeout — prevents indefinite hang on corrupted files
      await Promise.race([
        new Promise(r => { video.onseeked = () => { video.onseeked = null; r(); }; }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Seek timed out')), 8000)),
      ]);
      video.muted = true;
      video.playbackRate = speed; // apply current speed to export
      video.play();

      await new Promise(resolve => {
        let raf;
        const done = () => { video.pause(); video.onended = null; cancelAnimationFrame(raf); resolve(); };
        const tick = () => {
          const t = video.currentTime;
          oc.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
          annotations.filter(a => a.time <= t && t < (a.endTime ?? 9999)).forEach(a => drawAnnotation(oc, a, outW, outH));
          drawSubtitleOverlay(oc, outW, outH, t);
          elapsed += 1 / 30;
          exportStatus.textContent = `Encoding ${preset.name}… ${Math.min(99, Math.round((elapsed / totalDur) * 100))}%`;
          if (t >= range.end - 0.05 || video.ended) done(); else raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        video.onended = done;
      });
    }

    mr.stop();
    await new Promise(r => { mr.onstop = async () => { await _writeQueue; r(); }; });
    exportStatus.textContent = 'Saving…';
    await window.api.exportStreamClose();
    exportStatus.textContent = `✓ Saved (${preset.name})!`;
    setTimeout(() => { exportStatus.textContent = ''; }, 4000);
  } catch (err) {
    if (mr.state !== 'inactive') mr.stop();
    await _writeQueue.catch(() => {});
    await window.api.exportStreamClose().catch(() => {});
    exportStatus.textContent = `Export failed: ${err.message}`;
    setTimeout(() => { exportStatus.textContent = ''; }, 5000);
  } finally {
    video.muted = false;
    video.onseeked = null;
    video.onended = null;
  }
}

// ── Processed upload (canvas-rendered blob → Supabase) ────
async function runProcessedUpload(title, accessToken, userId, onProgress) {
  let keepRanges = [];
  let cursor = trimIn;
  [...cuts].sort((a, b) => a.start - b.start).forEach(c => {
    if (cursor < c.start) keepRanges.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  });
  if (cursor < trimOut) keepRanges.push({ start: cursor, end: trimOut });
  if (!keepRanges.length) keepRanges = [{ start: trimIn, end: trimOut }];

  const vW = video.videoWidth  || 1280;
  const vH = video.videoHeight || 720;
  const offCanvas = document.createElement('canvas');
  offCanvas.width = vW; offCanvas.height = vH;
  const oc = offCanvas.getContext('2d');

  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
  const stream = offCanvas.captureStream(30);
  const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });

  const chunks = [];
  mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  mr.start(200);

  const totalDur = keepRanges.reduce((s, r) => s + r.end - r.start, 0);
  let elapsed = 0;

  try {
    for (const range of keepRanges) {
      video.currentTime = range.start;
      await Promise.race([
        new Promise(r => { video.onseeked = () => { video.onseeked = null; r(); }; }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Seek timed out')), 8000)),
      ]);
      video.muted = true;
      video.playbackRate = speed;
      video.play();

      await new Promise(resolve => {
        let raf;
        const done = () => { video.pause(); video.onended = null; cancelAnimationFrame(raf); resolve(); };
        const tick = () => {
          const t = video.currentTime;
          oc.drawImage(video, 0, 0, vW, vH);
          annotations.filter(a => a.time <= t && t < (a.endTime ?? 9999)).forEach(a => drawAnnotation(oc, a, vW, vH));
          drawSubtitleOverlay(oc, vW, vH, t);
          elapsed += 1 / 30;
          onProgress(Math.min(80, Math.round((elapsed / totalDur) * 80)));
          if (t >= range.end - 0.05 || video.ended) done(); else raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        video.onended = done;
      });
    }

    mr.stop();
    await new Promise(r => { mr.onstop = () => r(); });

    const blob = new Blob(chunks, { type: mimeType });

    // Upload blob to Supabase storage
    const recordId  = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const objectPath = `${userId}/${recordId}.webm`;

    // Upload blob via TUS (chunked) to avoid 50MB single-request limit
    onProgress(82);
    await tusUploadBlob(blob, objectPath, (pct) => {
      onProgress(82 + pct * 0.13); // 82 → 95
    });

    onProgress(95);
    const pInsRes = await fetch(`${SUPABASE_URL}/rest/v1/recordings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE}`,
        apikey: SUPABASE_SERVICE,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        user_id:        userId,
        share_id:       recordId,
        title:          title,
        duration:       Math.round(totalDur / speed),
        file_size:      blob.size,
        mime_type:      'video/webm',
        storage_path:   objectPath,
        status:         'ready',
        recording_mode: 'screen',
        is_public:      true,
      }),
    });
    if (!pInsRes.ok) {
      const err = await pInsRes.json().catch(() => ({}));
      throw new Error(err.message || err.error || `DB insert failed: ${pInsRes.status}`);
    }

    onProgress(100);
    return recordId;
  } finally {
    video.muted = false;
    video.onseeked = null;
    video.onended = null;
    if (mr.state !== 'inactive') mr.stop();
  }
}

// ── Playback speed popup ──────────────────────────────────
const speedBtn   = document.getElementById('speed-btn');
const speedPopup = document.getElementById('speed-popup');

speedBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (speedPopup.style.display === 'block') { speedPopup.style.display = 'none'; return; }
  const r = speedBtn.getBoundingClientRect();
  speedPopup.style.left    = r.left + 'px';
  speedPopup.style.bottom  = (window.innerHeight - r.top + 8) + 'px';
  speedPopup.style.top     = 'auto';
  speedPopup.style.display = 'block';
});

document.querySelectorAll('.speed-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    const spd = parseFloat(opt.dataset.speed);
    speed = spd;
    video.playbackRate = spd;
    document.querySelectorAll('.speed-opt').forEach(x => x.classList.remove('active'));
    opt.classList.add('active');
    speedBtn.textContent = opt.dataset.speed + '×';
    speedPopup.style.display = 'none';
  });
});

document.addEventListener('click', e => {
  if (!speedPopup.contains(e.target) && e.target !== speedBtn) speedPopup.style.display = 'none';
});

// ── Back ──────────────────────────────────────────────────
document.getElementById('back-btn').addEventListener('click', () => {
  window.api.editorDone();
});

// ════════════════════════════════════════════════════════
// ── UPLOAD TO WEB ─────────────────────────────────────
// ════════════════════════════════════════════════════════

const SUPABASE_URL  = 'https://bgsvuywxejpmkstgqizq.supabase.co';

const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnc3Z1eXd4ZWpwbWtzdGdxaXpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MDc0MzMsImV4cCI6MjA4NzE4MzQzM30.EvHOy5sBbXzSxjRS5vPGzm8cnFrOXxDfclP-ru3VU_M';
// Service role key — bypasses RLS; injected at patch time, never committed to git
const SUPABASE_SERVICE = '__SUPABASE_SERVICE_KEY__';

// TUS upload for a Blob (used by runProcessedUpload after canvas rendering)
async function tusUploadBlob(blob, objectPath, onProgress) {
  const fileSize = blob.size;
  const endpoint = `${SUPABASE_URL}/storage/v1/upload/resumable`;
  const base64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const metadata = [
    `bucketName ${base64('recordings')}`,
    `objectName ${base64(objectPath)}`,
    `contentType ${base64(blob.type || 'video/webm')}`,
    `cacheControl ${base64('max-age=3600')}`,
  ].join(',');

  const createRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE}`,
      'x-upsert': 'true',
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(fileSize),
      'Upload-Metadata': metadata,
    },
  });
  if (!createRes.ok && createRes.status !== 201) {
    const t = await createRes.text().catch(() => '');
    throw new Error(`TUS create failed (${createRes.status}): ${t}`);
  }
  const uploadUrl = createRes.headers.get('location');
  if (!uploadUrl) throw new Error('TUS: no location header');

  const CHUNK_SZ = 6 * 1024 * 1024;
  let offset = 0;
  while (offset < fileSize) {
    const len = Math.min(CHUNK_SZ, fileSize - offset);
    const chunk = blob.slice(offset, offset + len);

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PATCH', uploadUrl);
      xhr.setRequestHeader('Authorization', `Bearer ${SUPABASE_SERVICE}`);
      xhr.setRequestHeader('Tus-Resumable', '1.0.0');
      xhr.setRequestHeader('Upload-Offset', String(offset));
      xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(((offset + e.loaded) / fileSize) * 100);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`TUS chunk failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('TUS network error'));
      xhr.send(chunk);
    });
    offset += len;
  }
}

// TUS resumable upload — chunks the file into 6MB pieces, works for files of any size
async function tusUpload(filePath, fileSize, objectPath, onProgress) {
  const endpoint = `${SUPABASE_URL}/storage/v1/upload/resumable`;
  const authHeaders = {
    Authorization: `Bearer ${SUPABASE_SERVICE}`,
    'x-upsert': 'true',
  };

  // 1. Create upload
  const base64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const metadata = [
    `bucketName ${base64('recordings')}`,
    `objectName ${base64(objectPath)}`,
    `contentType ${base64('video/webm')}`,
    `cacheControl ${base64('max-age=3600')}`,
  ].join(',');

  const createRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(fileSize),
      'Upload-Metadata': metadata,
    },
  });
  if (!createRes.ok && createRes.status !== 201) {
    const t = await createRes.text().catch(() => '');
    throw new Error(`TUS create failed (${createRes.status}): ${t}`);
  }
  const uploadUrl = createRes.headers.get('location');
  if (!uploadUrl) throw new Error('TUS: no location header');

  // 2. Upload chunks
  const CHUNK_SZ = 6 * 1024 * 1024; // 6MB — below free-plan 50MB limit
  let offset = 0;
  while (offset < fileSize) {
    const len = Math.min(CHUNK_SZ, fileSize - offset);
    const chunk = await window.api.readFileChunk(filePath, offset, len);
    if (!chunk) throw new Error(`Failed reading at offset ${offset}`);

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PATCH', uploadUrl);
      xhr.setRequestHeader('Authorization', `Bearer ${SUPABASE_SERVICE}`);
      xhr.setRequestHeader('Tus-Resumable', '1.0.0');
      xhr.setRequestHeader('Upload-Offset', String(offset));
      xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const total = offset + e.loaded;
          const pct = (total / fileSize) * 100;
          const sentMB = (total / 1024 / 1024).toFixed(1);
          onProgress(pct, sentMB);
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`TUS chunk failed (${xhr.status}): ${xhr.responseText}`));
      };
      xhr.onerror = () => reject(new Error('TUS network error'));
      xhr.send(chunk);
    });

    offset += len;
  }
}
const APP_URL       = 'https://screencast-eight.vercel.app';
const CHUNK_SIZE    = 8 * 1024 * 1024; // 8 MB per chunk

let _uploadSession  = null; // { access_token, user_id } — persisted in localStorage
let _uploadRecordId = null;

// Load saved session
try {
  const saved = localStorage.getItem('br_upload_session');
  if (saved) _uploadSession = JSON.parse(saved);
} catch {}

// ── Auto-upload status bar helpers ────────────────────────
const _auBar      = () => document.getElementById('auto-upload-bar');
const _auLabel    = () => document.getElementById('auto-upload-label');
const _auPbar     = () => document.getElementById('auto-upload-pbar');
const _auShareBtn = () => document.getElementById('auto-upload-share-btn');

function _auShow(state, text, pct) {
  const bar = _auBar();
  bar.className = state; // '', 'uploading', 'error'
  bar.style.display = 'flex';
  _auLabel().textContent = text;
  _auPbar().style.width = (pct ?? 0) + '%';
}

function _auDone(publicUrl) {
  const bar = _auBar();
  bar.className = '';
  bar.style.display = 'flex';
  _auPbar().style.width = '100%';
  _auLabel().textContent = 'Uploaded';
  const btn = _auShareBtn();
  btn.style.display = 'inline-block';
  btn.onclick = () => window.api.openExternal(publicUrl);
}

function _auError(msg) {
  _auShow('error', 'Upload failed: ' + msg, 0);
}

// ── Auto-upload: fires when editor opens with a logged-in session ──
async function autoUpload() {
  if (!currentFilePath) return;
  if (_autoUploadInProgress) return;
  _autoUploadInProgress = true;
  // Always prefer a fresh session from the main process
  const freshSession = await window.api.getUserSession().catch(() => null);
  if (freshSession && freshSession.access_token) {
    _uploadSession = {
      access_token:  freshSession.access_token,
      refresh_token: freshSession.refresh_token,
      user_id:       freshSession.user?.id || freshSession.user_id,
      email:         freshSession.user?.email,
    };
    localStorage.setItem('br_upload_session', JSON.stringify(_uploadSession));
  } else if (!_uploadSession || !_uploadSession.refresh_token) {
    _auBar().style.display = 'none';
    return;
  }

  try {
    // 1. Silently refresh the token
    _auShow('uploading', 'Preparing upload…', 2);
    try {
      const refRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON },
        body: JSON.stringify({ refresh_token: _uploadSession.refresh_token }),
      });
      if (refRes.ok) {
        const refData = await refRes.json();
        _uploadSession.access_token  = refData.access_token;
        _uploadSession.refresh_token = refData.refresh_token;
        localStorage.setItem('br_upload_session', JSON.stringify(_uploadSession));
      } else {
        // Token refresh failed — clear session, don't block the user
        _uploadSession = null;
        localStorage.removeItem('br_upload_session');
        _auBar().style.display = 'none';
        return;
      }
    } catch {
      // Network error during refresh — attempt upload with existing token
    }

    const { access_token, user_id } = _uploadSession;
    const recordId   = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const objectPath = `${user_id}/${recordId}.webm`; // path within bucket (no bucket prefix)

    // 2. Get file size
    _auShow('uploading', 'Reading file…', 4);
    const fileSize = await window.api.getFileSize(currentFilePath);
    if (!fileSize) { _auError('Could not read recording file'); return; }

    // 3. Upload via TUS resumable (works for any file size)
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);
    _auShow('uploading', `Uploading 0MB / ${fileSizeMB}MB`, 5);
    try {
      await tusUpload(currentFilePath, fileSize, objectPath, (pct, sent) => {
        _auShow('uploading', `Uploading ${sent}MB / ${fileSizeMB}MB (${Math.round(pct)}%)`, 5 + pct * 0.85);
      });
    } catch (e) {
      _auError(e.message || 'Upload failed');
      return;
    }
    _auShow('uploading', 'Saving…', 90);

    // 4. Save metadata to recordings table → appears in Vercel dashboard
    const autoInsRes = await fetch(`${SUPABASE_URL}/rest/v1/recordings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE}`,
        apikey: SUPABASE_SERVICE,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        user_id:        user_id,
        share_id:       recordId,
        title:          `Recording ${new Date().toLocaleString('tr-TR', { hour:'2-digit', minute:'2-digit', month:'short', day:'numeric' })}`,
        duration:       Math.round(duration || 0),
        file_size:      fileSize,
        mime_type:      'video/webm',
        storage_path:   objectPath,
        status:         'ready',
        recording_mode: 'screen',
        is_public:      true,
      }),
    });
    if (!autoInsRes.ok) {
      const err = await autoInsRes.json().catch(() => ({}));
      console.error('autoUpload INSERT failed:', err);
      _auError(err.message || err.error || `DB insert failed (${autoInsRes.status})`);
      return;
    }

    // 5. Done — show Share button
    _autoUploadedStoragePath = objectPath; // mark so manual upload skips duplicate INSERT
    _auDone(`${APP_URL}/watch/${recordId}`);

  } catch (err) {
    _auError(err.message || 'Unknown error');
  } finally {
    _autoUploadInProgress = false;
  }
}

document.getElementById('upload-web-btn').addEventListener('click', () => {
  openUploadModal();
});

function openUploadModal() {
  const modal     = document.getElementById('upload-modal');
  const loginWrap = document.getElementById('upload-login-wrap');
  const userInfo  = document.getElementById('upload-user-info');
  const goBtn     = document.getElementById('upload-go-btn');
  const errEl     = document.getElementById('upload-err');
  const progWrap  = document.getElementById('upload-progress-wrap');
  const succWrap  = document.getElementById('upload-success-wrap');

  errEl.style.display   = 'none';
  progWrap.style.display = 'none';
  succWrap.style.display = 'none';
  _uploadRecordId = null;

  // Clear stale sessions that have no refresh_token (can't silently renew)
  if (_uploadSession && !_uploadSession.refresh_token) {
    _uploadSession = null;
    localStorage.removeItem('br_upload_session');
  }

  if (_uploadSession) {
    loginWrap.style.display = 'none';
    userInfo.style.display  = 'block';
    userInfo.textContent    = `Logged in · ${_uploadSession.email || ''}`;
    goBtn.textContent       = '↑ Upload';
  } else {
    loginWrap.style.display = 'flex';
    userInfo.style.display  = 'none';
    goBtn.textContent       = 'Log in & Upload';
    document.getElementById('upload-email').value    = '';
    document.getElementById('upload-password').value = '';
  }

  // Pre-fill title with timestamp
  document.getElementById('upload-title').value =
    `Recording ${new Date().toLocaleString('tr-TR', { hour:'2-digit', minute:'2-digit', month:'short', day:'numeric' })}`;

  modal.style.display = 'flex';
}

document.getElementById('upload-cancel-btn').addEventListener('click', () => {
  document.getElementById('upload-modal').style.display = 'none';
});

document.getElementById('upload-go-btn').addEventListener('click', async () => {
  const errEl    = document.getElementById('upload-err');
  const goBtn    = document.getElementById('upload-go-btn');
  const progWrap = document.getElementById('upload-progress-wrap');
  const succWrap = document.getElementById('upload-success-wrap');
  const statusEl = document.getElementById('upload-status');
  const pfill    = document.getElementById('upload-pbar-fill');

  errEl.style.display   = 'none';
  goBtn.disabled        = true;

  try {
    // ── 1. Auth ──────────────────────────────────────────
    progWrap.style.display = 'flex';
    pfill.style.width = '5%';

    if (!_uploadSession) {
      const email    = document.getElementById('upload-email').value.trim();
      const password = document.getElementById('upload-password').value;
      if (!email || !password) throw new Error('Email and password required');

      statusEl.textContent = 'Signing in…';
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON },
        body: JSON.stringify({ email, password }),
      });
      const authData = await authRes.json();
      if (!authRes.ok) throw new Error(authData.error_description || authData.msg || 'Login failed');

      _uploadSession = { access_token: authData.access_token, refresh_token: authData.refresh_token, user_id: authData.user.id, email };
      localStorage.setItem('br_upload_session', JSON.stringify(_uploadSession));
      document.getElementById('upload-login-wrap').style.display = 'none';
      document.getElementById('upload-user-info').style.display  = 'block';
      document.getElementById('upload-user-info').textContent = `Logged in · ${email}`;
    } else {
      // Always get a fresh token from the main process (handles refresh automatically)
      statusEl.textContent = 'Refreshing session…';
      const freshSession = await window.api.getUserSession().catch(() => null);
      if (freshSession && freshSession.access_token) {
        _uploadSession.access_token  = freshSession.access_token;
        _uploadSession.user_id       = freshSession.user?.id || freshSession.user_id || _uploadSession.user_id;
        localStorage.setItem('br_upload_session', JSON.stringify(_uploadSession));
      } else if (_uploadSession.refresh_token) {
        // fallback: manual refresh
        const refRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON },
          body: JSON.stringify({ refresh_token: _uploadSession.refresh_token }),
        }).catch(() => null);
        if (refRes && refRes.ok) {
          const refData = await refRes.json();
          _uploadSession.access_token  = refData.access_token;
          _uploadSession.refresh_token = refData.refresh_token;
          localStorage.setItem('br_upload_session', JSON.stringify(_uploadSession));
        } else {
          _uploadSession = null;
          localStorage.removeItem('br_upload_session');
          throw new Error('Session expired — please log in again');
        }
      } else {
        throw new Error('Session expired — please log in again');
      }
    }

    const { access_token, user_id } = _uploadSession;
    const title    = document.getElementById('upload-title').value.trim() || 'Recording';

    let objectPath;
    let recordId;

    const hasEdits = cuts.length > 0 || speed !== 1 || subtitleSegments.length > 0;

    if (hasEdits) {
      // ── Processed upload: render through canvas first ─────
      statusEl.textContent = 'Rendering…';
      pfill.style.width = '10%';
      recordId = await runProcessedUpload(title, access_token, user_id, pct => {
        pfill.style.width = (10 + pct * 0.85) + '%';
        statusEl.textContent = pct < 80 ? `Rendering… ${pct}%` : pct < 95 ? 'Uploading…' : 'Saving…';
      });
      objectPath = `${user_id}/${recordId}.webm`;
    } else if (_autoUploadedStoragePath) {
      // ── Auto-upload already stored this file — just update title
      objectPath = _autoUploadedStoragePath;
      recordId = objectPath.split('/').pop().replace('.webm', '');

      pfill.style.width = '95%';
      statusEl.textContent = 'Saving…';
      await fetch(`${SUPABASE_URL}/rest/v1/recordings?storage_path=eq.${encodeURIComponent(objectPath)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE}`,
          apikey: SUPABASE_SERVICE,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ title }),
      }).catch(() => {});
    } else {
      // ── Raw file upload ───────────────────────────────────
      recordId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      objectPath = `${user_id}/${recordId}.webm`;

      statusEl.textContent = 'Reading file…';
      pfill.style.width = '5%';
      const fileSize = await window.api.getFileSize(currentFilePath);
      if (!fileSize) throw new Error('Could not read recording file');
      const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);

      // Use TUS resumable upload — supports files of any size by chunking into 6MB pieces
      await tusUpload(currentFilePath, fileSize, objectPath, (pct, sent) => {
        pfill.style.width = (5 + pct * 0.85) + '%';
        statusEl.textContent = `Uploading ${sent}MB / ${fileSizeMB}MB (${Math.round(pct)}%)`;
      });
      pfill.style.width = '90%';

      pfill.style.width = '95%';
      statusEl.textContent = 'Saving…';
      const insRes = await fetch(`${SUPABASE_URL}/rest/v1/recordings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE}`,
          apikey: SUPABASE_SERVICE,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          user_id:        user_id,
          share_id:       recordId,
          title:          title,
          duration:       Math.round(duration || 0),
          file_size:      fileSize,
          mime_type:      'video/webm',
          storage_path:   objectPath,
          status:         'ready',
          recording_mode: 'screen',
          is_public:      true,
        }),
      });
      if (!insRes.ok) {
        const e = await insRes.json().catch(() => ({}));
        throw new Error(e.message || e.error || `DB insert failed: ${insRes.status}`);
      }
    }

    // ── 5. Build share URL ────────────────────────────────
    statusEl.textContent = 'Finalizing…';
    const publicUrl = `${APP_URL}/watch/${recordId}`;

    pfill.style.width = '100%';
    progWrap.style.display = 'none';
    succWrap.style.display = 'flex';

    document.getElementById('upload-open-btn').onclick = () => {
      window.api.openExternal(publicUrl);
    };

  } catch (e) {
    errEl.textContent   = e.message;
    errEl.style.display = 'block';
    progWrap.style.display = 'none';
  } finally {
    goBtn.disabled = false;
  }
});

// ════════════════════════════════════════════════════════
// ── SUBTITLES ─────────────────────────────────────────
// ════════════════════════════════════════════════════════

// ── Tab switching ─────────────────────────────────────────
document.getElementById('tab-edit-btn').addEventListener('click', () => {
  document.getElementById('tab-edit-btn').classList.add('active');
  document.getElementById('tab-sub-btn').classList.remove('active');
  document.getElementById('tab-edit').classList.add('active');
  document.getElementById('tab-sub').classList.remove('active');
});
document.getElementById('tab-sub-btn').addEventListener('click', () => {
  document.getElementById('tab-sub-btn').classList.add('active');
  document.getElementById('tab-edit-btn').classList.remove('active');
  document.getElementById('tab-sub').classList.add('active');
  document.getElementById('tab-edit').classList.remove('active');
});

// ── Subtitle background swatches ──────────────────────────
const subBgOptions = [
  { bg: 'none',                     style: 'transparent', border: '#555', label: '∅' },
  { bg: 'rgba(0,0,0,0.78)',         style: '#000' },
  { bg: 'rgba(239,68,68,0.85)',     style: '#ef4444' },
  { bg: 'rgba(250,204,21,0.85)',    style: '#facc15' },
  { bg: 'rgba(74,222,128,0.88)',    style: '#4ade80' },
  { bg: 'rgba(96,165,250,0.88)',    style: '#60a5fa' },
  { bg: 'rgba(232,121,249,0.88)',   style: '#e879f9' },
];
const subBgRow = document.getElementById('sub-bg-row');
subBgOptions.forEach((opt, i) => {
  const el = document.createElement('div');
  el.className = 'sub-swatch' + (i === 1 ? ' active' : '');
  el.style.background = opt.style;
  el.style.border = `2px solid ${opt.border || 'transparent'}`;
  el.textContent = opt.label || '';
  el.title = opt.bg === 'none' ? 'No background' : '';
  el.addEventListener('click', () => {
    subBgRow.querySelectorAll('.sub-swatch').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    subtitleBg = opt.bg;
    redrawAnnotations();
  });
  subBgRow.appendChild(el);
});

// ── Subtitle text color swatches ──────────────────────────
const subTxtOptions = [
  { col: '#ffffff', style: '#ffffff', border: '#555' },
  { col: '#111111', style: '#111111' },
  { col: '#facc15', style: '#facc15' },
  { col: '#60a5fa', style: '#60a5fa' },
];
const subTxtRow = document.getElementById('sub-txt-row');
subTxtOptions.forEach((opt, i) => {
  const el = document.createElement('div');
  el.className = 'sub-swatch' + (i === 0 ? ' active' : '');
  el.style.background = opt.style;
  el.style.border = `2px solid ${opt.border || 'transparent'}`;
  el.addEventListener('click', () => {
    subTxtRow.querySelectorAll('.sub-swatch').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    subtitleTxtCol = opt.col;
    redrawAnnotations();
  });
  subTxtRow.appendChild(el);
});

// ── Subtitle size slider ──────────────────────────────────
document.getElementById('sub-size').addEventListener('input', e => {
  subtitleFontSize = +e.target.value;
  document.getElementById('sub-size-val').textContent = subtitleFontSize;
  redrawAnnotations();
});

// ── Generate ──────────────────────────────────────────────
document.getElementById('sub-gen-btn').addEventListener('click', generateSubtitles);

async function generateSubtitles() {
  if (!currentFilePath) {
    document.getElementById('sub-status').textContent = 'No video loaded.';
    return;
  }
  const btn      = document.getElementById('sub-gen-btn');
  const statusEl = document.getElementById('sub-status');
  const pbar     = document.getElementById('sub-pbar');
  const pfill    = document.getElementById('sub-pbar-fill');

  btn.disabled = true;
  pbar.style.display = 'block';
  pfill.style.width  = '0%';

  try {
    // Load Whisper model
    statusEl.textContent = 'Downloading Whisper Small (~150MB, only once, cached)…';
    if (!_whisperPipe) {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
      env.allowLocalModels = false;
      _whisperPipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
        dtype: 'q8',
        progress_callback: p => {
          if (p.progress != null) {
            pfill.style.width = Math.round(p.progress) + '%';
            statusEl.textContent = `Downloading… ${Math.round(p.progress)}%`;
          }
        },
      });
    }

    // Stream file directly via file:// — avoids IPC serialization bottleneck
    statusEl.textContent = 'Reading audio…';
    pfill.style.width = '10%';
    const response = await fetch(`file://${currentFilePath}`);
    if (!response.ok) throw new Error('Could not read video file');
    const buf = await response.arrayBuffer();

    // Decode audio at 16kHz — always close context even on error
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    let audio;
    try {
      const decoded = await audioCtx.decodeAudioData(buf);
      const ch0 = decoded.getChannelData(0);
      const ch1 = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : null;
      audio = ch1
        ? Float32Array.from({ length: ch0.length }, (_, i) => (ch0[i] + ch1[i]) / 2)
        : Float32Array.from(ch0);
    } finally {
      await audioCtx.close();
    }

    // Transcribe
    statusEl.textContent = 'Transcribing… (takes ~same time as video length)';
    pfill.style.width = '30%';

    const selectedLang = document.getElementById('sub-lang').value || null;

    const result = await _whisperPipe(audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      language: selectedLang,
      generate_kwargs: {
        no_repeat_ngram_size: 5,
        repetition_penalty: 1.3,
        condition_on_previous_text: false,
      },
    });

    const rawChunks = result?.chunks ?? [];

    // Detect and strip hallucination loops
    function isHallucinated(chunks) {
      const allWords = chunks.flatMap(c => (c.text || '').trim().split(/\s+/).filter(Boolean));
      if (allWords.length < 10) return false;
      const unique = new Set(allWords.map(w => w.toLowerCase().replace(/[^\p{L}]/gu, '')));
      // Less than 15% unique word ratio = repetition loop
      return unique.size / allWords.length < 0.15;
    }

    const deduped = isHallucinated(rawChunks)
      ? []
      : rawChunks.filter((c, i, arr) => {
          if (!c.text?.trim()) return false;
          const t = c.text.trim().toLowerCase();
          const prev = arr.slice(Math.max(0, i - 3), i).map(x => x.text?.trim().toLowerCase());
          return prev.filter(p => p === t).length < 2;
        });

    if (!deduped.length && rawChunks.length) {
      statusEl.textContent = '⚠ Hallucination detected — no clear speech found in audio.';
      btn.disabled = false;
      btn.textContent = 'Generate Subtitles';
      pbar.style.display = 'none';
      return;
    }

    subtitleSegments = deduped
      .map((c, i) => ({
        id: i,
        start: c.timestamp[0] ?? 0,
        end:   c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 3,
        text:  c.text.trim(),
      }));

    subtitleCuts = new Set();
    pfill.style.width = '100%';
    statusEl.textContent = `✓ ${subtitleSegments.length} segments`;
    setTimeout(() => { pbar.style.display = 'none'; }, 1500);

    renderSubtitleList();
    redrawAnnotations();
    drawTimeline();

  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
    pbar.style.display = 'none';
  } finally {
    btn.disabled = false;
    btn.textContent = subtitleSegments.length ? 'Regenerate' : 'Generate Subtitles';
    document.getElementById('sub-filler-btn').style.display = subtitleSegments.length ? 'block' : 'none';
  }
}

// ── Auto-remove filler words ──────────────────────────────
const FILLERS = /^(um|uh|em|ım|hmm|hm|ah|oh|eh|er|eee|mmm|şey|yani|işte|ee|aa|öö|ıı|mhm|uhh|ehh|ahh)$/i;

document.getElementById('sub-filler-btn').addEventListener('click', () => {
  if (!subtitleSegments.length) return;
  let added = 0;

  subtitleSegments.forEach(seg => {
    const words   = seg.text.split(/\s+/).filter(Boolean);
    const wordDur = (seg.end - seg.start) / (words.length || 1);

    words.forEach((w, i) => {
      const clean = w.replace(/[.,!?;:]+$/, '');
      if (!FILLERS.test(clean)) return;
      const t  = seg.start + i * wordDur;
      const te = seg.start + (i + 1) * wordDur;
      // Don't double-add
      const already = cuts.some(c => Math.abs(c.start - t) < 0.05);
      if (!already) { cuts.push({ start: t, end: te }); added++; }
    });
  });

  cuts.sort((a, b) => a.start - b.start);
  const msg = added ? `✓ Marked ${added} filler word${added > 1 ? 's' : ''} for removal` : 'No fillers found';
  document.getElementById('sub-status').textContent = msg;
  renderSubtitleList();
  drawTimeline();
  renderCutsList();
});

// ── Word drag-select state ────────────────────────────────
let _selStartT = null, _selEndT = null, _isDragging = false, _mouseDownT = null;

document.addEventListener('mouseup', () => {
  if (_isDragging) {
    _isDragging = false;
    const hasSel = document.querySelectorAll('.sub-word.sel').length > 0;
    document.getElementById('sub-cut-float').style.display = hasSel ? 'flex' : 'none';
  }
});

document.getElementById('sub-cut-float-btn').addEventListener('click', () => {
  const selected = Array.from(document.querySelectorAll('.sub-word.sel'));
  if (!selected.length) return;
  const times    = selected.map(w => parseFloat(w.dataset.t));
  const endTimes = selected.map(w => parseFloat(w.dataset.te));
  const start    = Math.min(...times);
  const end      = Math.max(...endTimes);
  if (end > start) {
    saveState();
    cuts.push({ start, end });
    cuts.sort((a, b) => a.start - b.start);
    drawTimeline();
  }
  _selStartT = _selEndT = null;
  document.getElementById('sub-cut-float').style.display = 'none';
  renderSubtitleList(); renderCutsList();
});

// ── Render segment list ───────────────────────────────────
function renderSubtitleList() {
  const container = document.getElementById('subtitle-segments');
  container.innerHTML = '';

  subtitleSegments.forEach(seg => {
    const isCut  = subtitleCuts.has(seg.id);
    const el     = document.createElement('div');
    el.className = 'sub-seg' + (isCut ? ' cut' : '');
    el.dataset.id = seg.id;
    el.dataset.segId = seg.id;

    const words   = seg.text.split(/\s+/).filter(Boolean);
    const wordDur = (seg.end - seg.start) / (words.length || 1);

    const wordHtml = words.map((w, i) => {
      const t   = seg.start + i * wordDur;
      const te  = seg.start + (i + 1) * wordDur;
      const cut = cuts.some(c => t >= c.start && t < c.end);
      return `<span class="sub-word${cut ? ' wcut' : ''}" data-t="${t.toFixed(3)}" data-te="${te.toFixed(3)}">${w}</span>`;
    }).join('');

    el.innerHTML = `
      <div class="sub-seg-header">
        <span class="sub-seg-time">${fmt(seg.start)}</span>
        <button class="sub-edit-btn" title="Edit text">✎</button>
        <button class="sub-cut-btn">${isCut ? '↩ Restore' : '✂ Cut all'}</button>
      </div>
      <div class="sub-words">${wordHtml}</div>`;

    // Word events: mousedown starts drag, mouseup short click = seek
    el.querySelectorAll('.sub-word').forEach(wEl => {
      wEl.addEventListener('mousedown', e => {
        e.preventDefault();
        _isDragging  = false;
        _mouseDownT  = parseFloat(wEl.dataset.t);
        _selStartT   = parseFloat(wEl.dataset.t);
        _selEndT     = parseFloat(wEl.dataset.te);
        // clear previous selection
        document.querySelectorAll('.sub-word.sel').forEach(x => x.classList.remove('sel'));
        document.getElementById('sub-cut-float').style.display = 'none';
      });

      wEl.addEventListener('mouseover', e => {
        if (e.buttons !== 1 || _selStartT === null) return;
        _isDragging = true;
        const wt = parseFloat(wEl.dataset.t);
        const te = parseFloat(wEl.dataset.te);
        _selEndT = Math.max(_selEndT ?? te, te);
        const lo = Math.min(_selStartT, wt);
        const hi = Math.max(_selEndT, te);
        document.querySelectorAll('.sub-word').forEach(x => {
          const xt = parseFloat(x.dataset.t);
          x.classList.toggle('sel', xt >= lo && xt <= hi);
        });
      });

      wEl.addEventListener('mouseup', e => {
        if (!_isDragging) {
          // single click → seek + select this word + cut it immediately
          const t  = parseFloat(wEl.dataset.t);
          const te = parseFloat(wEl.dataset.te);
          video.currentTime = t;
          if (te > t) {
            saveState();
            cuts.push({ start: t, end: te });
            cuts.sort((a, b) => a.start - b.start);
            drawTimeline(); renderCutsList(); renderSubtitleList();
          }
        }
      });
    });

    el.querySelector('.sub-seg-time').addEventListener('click', e => {
      e.stopPropagation();
      video.currentTime = seg.start;
    });

    el.querySelector('.sub-edit-btn').addEventListener('click', e => {
      e.stopPropagation();
      const wordsDiv = el.querySelector('.sub-words');
      const ta = document.createElement('textarea');
      ta.className = 'sub-edit-area';
      ta.value = seg.text;
      ta.rows = 2;
      wordsDiv.replaceWith(ta);
      ta.focus();
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      });
      const commit = () => {
        const newText = ta.value.trim();
        if (newText) subtitleSegments[subtitleSegments.findIndex(s => s.id === seg.id)].text = newText;
        renderSubtitleList();
        redrawAnnotations();
      };
      ta.addEventListener('blur', commit);
      ta.addEventListener('keydown', e2 => {
        if (e2.key === 'Escape') { renderSubtitleList(); }
      });
    });

    el.querySelector('.sub-cut-btn').addEventListener('click', e => {
      e.stopPropagation();
      toggleSubtitleCut(seg.id);
    });

    container.appendChild(el);
  });
}

// ── Toggle subtitle cut ───────────────────────────────────
function toggleSubtitleCut(segId) {
  const seg = subtitleSegments.find(s => s.id === segId);
  if (!seg) return;

  if (subtitleCuts.has(segId)) {
    subtitleCuts.delete(segId);
    cuts = cuts.filter(c => !(Math.abs(c.start - seg.start) < 0.05 && Math.abs(c.end - seg.end) < 0.05));
  } else {
    subtitleCuts.add(segId);
    cuts.push({ start: seg.start, end: seg.end });
    cuts.sort((a, b) => a.start - b.start);
  }

  renderSubtitleList();
  drawTimeline();
  renderCutsList();
}

// ── Highlight current segment while playing ───────────────
function highlightCurrentSubSegment() {
  if (!subtitleSegments.length) return;
  const t   = video.currentTime || 0;
  const idx = subtitleSegments.findIndex(s => t >= s.start && t < s.end);

  document.querySelectorAll('.sub-seg').forEach((el, i) => {
    const wasPlaying = el.classList.contains('playing');
    el.classList.toggle('playing', i === idx && !subtitleCuts.has(subtitleSegments[i]?.id));
    if (i === idx && !wasPlaying && !subtitleCuts.has(subtitleSegments[i]?.id)) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

// ── Draw subtitle overlay on canvas ──────────────────────
function drawSubtitleOverlay(c, W, H, t) {
  if (!subtitleSegments.length) return;

  const fs = subtitleFontSize;
  const px = 18, py = 9;

  // Always keep bbox current so drag/resize works even when no subtitle showing
  if (c === ctx) {
    c.save();
    c.font = `bold ${fs}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
    const sampleW = c.measureText(subtitleSegments[0]?.text || 'Subtitle').width;
    const bw = Math.min(sampleW + px * 2, W * 0.95);
    const bh = fs + py * 2;
    _subBBox = { bx: subtitlePos.x * W - bw / 2, by: subtitlePos.y * H - bh / 2, bw, bh };
    c.restore();
  }

  const seg = subtitleSegments.find(s => t >= s.start && t < s.end && !subtitleCuts.has(s.id));
  if (!seg) {
    // Draw ghost handle so user can reposition even when no subtitle active
    if (c === ctx) {
      const { bx, by, bw, bh } = _subBBox;
      c.save();
      c.strokeStyle = 'rgba(255,255,255,0.15)';
      c.lineWidth = 1;
      c.setLineDash([4, 4]);
      c.strokeRect(bx, by, bw, bh);
      // resize corner
      const hs = 10;
      c.fillStyle = 'rgba(255,255,255,0.25)';
      c.beginPath();
      c.moveTo(bx + bw - hs, by + bh);
      c.lineTo(bx + bw, by + bh);
      c.lineTo(bx + bw, by + bh - hs);
      c.closePath();
      c.fill();
      c.restore();
    }
    return;
  }

  const text = seg.text;

  c.save();
  c.font = `bold ${fs}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  c.textBaseline = 'alphabetic';

  const textW = c.measureText(text).width;
  const bw    = Math.min(textW + px * 2, W * 0.95);
  const bh    = fs + py * 2;
  const bx    = subtitlePos.x * W - bw / 2;
  const by    = subtitlePos.y * H - bh / 2;

  // Update bbox with actual text width
  if (c === ctx) _subBBox = { bx, by, bw, bh };

  if (subtitleBg !== 'none') {
    c.fillStyle = subtitleBg;
    c.beginPath();
    if (c.roundRect) c.roundRect(bx, by, bw, bh, 10);
    else c.rect(bx, by, bw, bh);
    c.fill();
  }

  c.fillStyle = subtitleTxtCol;
  c.fillText(seg.text, bx + px, by + py + fs * 0.85);

  // Resize handle at bottom-right (only on preview canvas)
  if (c === ctx) {
    const hs = 10;
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.beginPath();
    c.moveTo(bx + bw - hs, by + bh);
    c.lineTo(bx + bw, by + bh);
    c.lineTo(bx + bw, by + bh - hs);
    c.closePath();
    c.fill();
  }

  c.restore();
}

// ── Subtitle drag + resize on canvas (when tool = none) ──
canvas.addEventListener('mousemove', e => {
  if (activeTool !== 'none' || !_subBBox) return;
  const r  = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) / r.width  * canvas.width;
  const cy = (e.clientY - r.top)  / r.height * canvas.height;
  const { bx, by, bw, bh } = _subBBox;
  const nearResize = cx >= bx + bw - 16 && cx <= bx + bw + 4 && cy >= by + bh - 16 && cy <= by + bh + 4;
  const over = cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh;

  if (_subResizing && e.buttons === 1) {
    const dy = cy - _subResizeStartY;
    subtitleFontSize = Math.max(12, Math.min(72, _subResizeStartSize + Math.round(dy / 2.5)));
    document.getElementById('sub-size').value = subtitleFontSize;
    document.getElementById('sub-size-val').textContent = subtitleFontSize;
    redrawAnnotations();
    return;
  }
  if (_subDragging && e.buttons === 1) {
    subtitlePos.x = Math.max(0.05, Math.min(0.95, cx / canvas.width));
    subtitlePos.y = Math.max(0.05, Math.min(0.95, cy / canvas.height));
    redrawAnnotations();
    return;
  }

  canvas.style.cursor = nearResize ? 'se-resize' : over ? 'move' : 'default';
});

canvas.addEventListener('mousedown', e => {
  if (activeTool !== 'none' || !_subBBox) return;
  const r  = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) / r.width  * canvas.width;
  const cy = (e.clientY - r.top)  / r.height * canvas.height;
  const { bx, by, bw, bh } = _subBBox;
  const nearResize = cx >= bx + bw - 16 && cx <= bx + bw + 4 && cy >= by + bh - 16 && cy <= by + bh + 4;
  const over = cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh;
  if (nearResize) {
    _subResizing = true;
    _subResizeStartY = cy;
    _subResizeStartSize = subtitleFontSize;
    e.preventDefault();
  } else if (over) {
    _subDragging = true;
    e.preventDefault();
  }
});
window.addEventListener('mouseup', () => { _subDragging = false; _subResizing = false; });
