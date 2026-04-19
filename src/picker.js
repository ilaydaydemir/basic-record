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
    const isPermission = e.message.includes('Failed to get sources') || e.message.includes('permission');
    grid.innerHTML = isPermission
      ? `<div style="grid-column:1/-1;padding:20px 0;">
           <div style="color:#f87171;font-size:13px;font-weight:600;margin-bottom:8px;">Screen Recording permission required</div>
           <div style="color:#666;font-size:12px;margin-bottom:14px;">Go to System Settings → Privacy &amp; Security → Screen Recording and enable Basic Record.</div>
           <button onclick="window.api.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')" style="background:#ef4444;border:none;color:#fff;border-radius:7px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;">Open System Settings →</button>
         </div>`
      : `<div style="color:#f87171;font-size:12px;grid-column:1/-1;padding:20px 0;">Error: ${e.message}</div>`;
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

// ── Countdown before recording ────────────────────────────
const countdownOverlay = document.getElementById('countdown-overlay');
const countdownNum     = document.getElementById('countdown-num');
const countdownCamBtn  = document.getElementById('countdown-cam-btn');
const countdownCancel  = document.getElementById('countdown-cancel');
let countdownCamOn = true;
let countdownTimer = null;

function startCountdown() {
  countdownCamOn = !!camSelect.value; // off if no cam selected
  updateCamBtn();
  countdownOverlay.style.display = 'flex';
  let n = 3;
  countdownNum.textContent = n;

  countdownTimer = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(countdownTimer);
      countdownOverlay.style.display = 'none';
      launchRecording();
    } else {
      countdownNum.textContent = n;
    }
  }, 1000);
}

function updateCamBtn() {
  countdownCamBtn.textContent = countdownCamOn ? '📷 Camera: On' : '📷 Camera: Off';
  countdownCamBtn.style.color = countdownCamOn ? '#ccc' : '#555';
}

countdownCamBtn.addEventListener('click', () => {
  if (!camSelect.value) return; // no cam, nothing to toggle
  countdownCamOn = !countdownCamOn;
  updateCamBtn();
});

countdownCancel.addEventListener('click', () => {
  clearInterval(countdownTimer);
  countdownOverlay.style.display = 'none';
  startBtn.disabled = false;
  startBtn.textContent = '▶ Start Recording';
});

async function launchRecording() {
  await window.api.startRecording({
    sourceId:       selectedSourceId,
    cameraDeviceId: (countdownCamOn && camSelect.value) ? camSelect.value : null,
    micDeviceId:    micSelect.value || null,
    region:         selectedRegion,
  });
}

startBtn.addEventListener('click', async () => {
  if (!selectedSourceId) return;
  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';

  // Re-check permission at click time
  try {
    const perm = await window.api.checkScreenPermission()
    if (perm !== 'granted') {
      window.api.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      startBtn.disabled = false;
      startBtn.textContent = '▶ Start Recording';
      return;
    }
  } catch {}

  startCountdown();
});

// ── Login overlay ─────────────────────────────────────────────
const loginOverlay = document.getElementById('login-overlay');
const loginEmail   = document.getElementById('login-email');
const loginPass    = document.getElementById('login-pass');
const loginBtn     = document.getElementById('login-btn');
const signupBtn    = document.getElementById('signup-btn');
const skipBtn      = document.getElementById('skip-login-btn');
const loginError   = document.getElementById('login-error');
let loginIsSignup  = false;

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.style.display = 'block';
}

async function doLogin(isSignup) {
  const email = loginEmail.value.trim();
  const pass  = loginPass.value;
  if (!email || !pass) { showLoginError('Email and password required'); return; }
  loginBtn.disabled = true;
  loginBtn.textContent = isSignup ? 'Creating account…' : 'Signing in…';
  loginError.style.display = 'none';
  try {
    const res = await window.api.userLogin({ email, password: pass, isSignup });
    if (res.ok) {
      loginOverlay.style.display = 'none';
      showUserBadge(email);
    } else {
      showLoginError(res.error || 'Authentication failed');
    }
  } catch (e) {
    showLoginError('Network error — check your connection');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = isSignup ? 'Create Account' : 'Sign In';
  }
}

loginBtn.addEventListener('click', () => doLogin(loginIsSignup));
loginPass.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(loginIsSignup); });

signupBtn.addEventListener('click', () => {
  loginIsSignup = !loginIsSignup;
  loginBtn.textContent  = loginIsSignup ? 'Create Account' : 'Sign In';
  signupBtn.textContent = loginIsSignup ? 'Back to sign in' : 'Create account';
  loginError.style.display = 'none';
});

skipBtn.addEventListener('click', () => {
  loginOverlay.style.display = 'none';
});

// Check if already logged in — skip overlay and show user badge
const userBadge      = document.getElementById('user-badge');
const userEmailLabel = document.getElementById('user-email-label');
const logoutBtn      = document.getElementById('logout-btn');

function showUserBadge(email) {
  userEmailLabel.textContent = email;
  userBadge.style.display = 'flex';
}

logoutBtn.addEventListener('click', async () => {
  await window.api.userLogout();
  userBadge.style.display = 'none';
  loginOverlay.style.display = 'flex';
  loginEmail.value = '';
  loginPass.value  = '';
  loginError.style.display = 'none';
  loginIsSignup = false;
  loginBtn.textContent  = 'Sign In';
  signupBtn.textContent = 'Create account';
});

(async () => {
  try {
    const session = await window.api.getUserSession();
    if (session?.access_token) {
      loginOverlay.style.display = 'none';
      if (session.email) showUserBadge(session.email);
    }
  } catch {}
})();

// Init
loadDevices();
loadSources();

// Check screen recording permission on load
(async () => {
  try {
    const perm = await window.api.checkScreenPermission()
    const banner = document.getElementById('perm-warning')
    if (banner && perm !== 'granted') {
      banner.style.display = 'flex'
    }
  } catch {}
})()

function fmtSize(b) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}
function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('tr-TR', { day:'numeric', month:'short' }) + ' ' +
         d.toLocaleTimeString('tr-TR', { hour:'2-digit', minute:'2-digit' });
}

async function loadRecordingsList() {
  const list = document.getElementById('recordings-list');
  list.innerHTML = '<div style="color:#444;font-size:12px;padding:20px 0;">Loading…</div>';
  const files = await window.api.listRecordings();
  if (!files.length) {
    list.innerHTML = '<div style="color:#444;font-size:12px;padding:20px 0;">No recordings found in Movies/Basic Record</div>';
    return;
  }
  list.innerHTML = '';
  files.forEach(f => {
    const row = document.createElement('button');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;width:100%;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:9px;padding:10px 14px;cursor:pointer;text-align:left;transition:border-color 0.15s;';
    row.onmouseover = () => row.style.borderColor = '#ef4444';
    row.onmouseout  = () => row.style.borderColor = '#2a2a2a';
    row.innerHTML = `
      <span style="font-size:20px;flex-shrink:0;">🎥</span>
      <span style="flex:1;overflow:hidden;">
        <span style="display:block;font-size:12px;font-weight:600;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${f.name}</span>
        <span style="display:block;font-size:11px;color:#555;margin-top:2px;">${fmtDate(f.mtime)} · ${fmtSize(f.size)}</span>
      </span>
      <span style="font-size:11px;color:#444;">▶</span>
    `;
    row.addEventListener('click', () => window.api.openRecordingFile(f.path));
    list.appendChild(row);
  });
}

document.getElementById('open-file-btn').addEventListener('click', () => {
  document.getElementById('recordings-overlay').style.display = 'flex';
  loadRecordingsList();
});
document.getElementById('recordings-back').addEventListener('click', () => {
  document.getElementById('recordings-overlay').style.display = 'none';
});
document.getElementById('recordings-refresh').addEventListener('click', loadRecordingsList);
