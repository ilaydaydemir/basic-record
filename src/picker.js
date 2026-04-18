let selectedSourceId = null;
let selectedRegion   = null; // {x,y,w,h} or null = full

const grid      = document.getElementById('source-grid');
const startBtn  = document.getElementById('start-btn');
const camSelect = document.getElementById('cam-select');
const micSelect = document.getElementById('mic-select');
const regionBtn = document.getElementById('region-btn');
const regionLabel = document.getElementById('region-label');

// Load cameras & mics
async function loadDevices() {
  try {
    await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(s => s.getTracks().forEach(t => t.stop()))
      .catch(() => {});
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    const mics    = devices.filter(d => d.kind === 'audioinput');

    camSelect.innerHTML = '<option value="">No camera</option>';
    cameras.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Camera ${d.deviceId.slice(0,6)}`;
      camSelect.appendChild(o);
    });
    if (cameras.length > 0) camSelect.value = cameras[0].deviceId;

    micSelect.innerHTML = '<option value="">No microphone</option>';
    mics.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Mic ${d.deviceId.slice(0,6)}`;
      micSelect.appendChild(o);
    });
    if (mics.length > 0) micSelect.value = mics[0].deviceId;
  } catch (e) {
    console.warn('Device enumeration failed:', e);
  }
}

// Load screen/window sources
async function loadSources() {
  grid.innerHTML = '<div style="color:#444;font-size:12px;grid-column:1/-1;padding:20px 0;">Loading…</div>';
  selectedSourceId = null;
  startBtn.disabled = true;

  try {
    const sources = await window.api.getSources();
    grid.innerHTML = '';

    sources.forEach(src => {
      const card = document.createElement('div');
      card.className = 'source-card';
      card.dataset.id = src.id;

      const wrap = document.createElement('div');
      wrap.className = 'thumb-wrap';
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = src.thumbnail;
      img.alt = src.name;
      wrap.appendChild(img);

      const label = document.createElement('div');
      label.className = 'source-name';
      label.textContent = src.name;

      card.appendChild(wrap);
      card.appendChild(label);

      card.addEventListener('click', () => {
        document.querySelectorAll('.source-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedSourceId = src.id;
        startBtn.disabled = false;
      });

      grid.appendChild(card);
    });

    if (sources.length === 0) {
      grid.innerHTML = '<div style="color:#444;font-size:12px;grid-column:1/-1;padding:20px 0;">No sources found. Try clicking refresh.</div>';
    }
  } catch (e) {
    grid.innerHTML = `<div style="color:#f87171;font-size:12px;grid-column:1/-1;padding:20px 0;">Error: ${e.message}</div>`;
  }
}

document.getElementById('refresh-btn').addEventListener('click', loadSources);

regionBtn?.addEventListener('click', async () => {
  if (!selectedSourceId) { alert('Pick a source first'); return; }
  regionBtn.textContent = 'Select area…';
  regionBtn.disabled = true;
  const rect = await window.api.selectRegion(selectedSourceId);
  regionBtn.disabled = false;
  if (rect) {
    selectedRegion = rect;
    regionLabel.textContent = `${rect.w}×${rect.h} at (${rect.x},${rect.y})`;
    regionLabel.style.display = 'block';
    regionBtn.textContent = 'Change Region ✓';
  } else {
    selectedRegion = null;
    regionLabel.style.display = 'none';
    regionBtn.textContent = 'Select Region';
  }
});

startBtn.addEventListener('click', async () => {
  if (!selectedSourceId) return;
  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';
  await window.api.startRecording({
    sourceId:       selectedSourceId,
    cameraDeviceId: camSelect.value || null,
    micDeviceId:    micSelect.value || null,
    region:         selectedRegion,
  });
});

// Init
loadDevices();
loadSources();
