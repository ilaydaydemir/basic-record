const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, shell, screen, systemPreferences } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');

// ── Auto-upload session (persisted across app restarts) ────
const SUPABASE_URL  = 'https://bgsvuywxejpmkstgqizq.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnc3Z1eXd4ZWpwbWtzdGdxaXpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MDc0MzMsImV4cCI6MjA4NzE4MzQzM30.EvHOy5sBbXzSxjRS5vPGzm8cnFrOXxDfclP-ru3VU_M';
let _deviceSession = null;

function deviceFilePath() {
  return path.join(app.getPath('userData'), 'device-session.json');
}

function loadDeviceSession() {
  try {
    const raw = fs.readFileSync(deviceFilePath(), 'utf8');
    _deviceSession = JSON.parse(raw);
  } catch {}
}

function saveDeviceSession(s) {
  _deviceSession = s;
  try { fs.writeFileSync(deviceFilePath(), JSON.stringify(s)); } catch {}
}

function sbFetch(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const req  = https.request(`${SUPABASE_URL}${urlPath}`, {
      method:  opts.method || 'GET',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_ANON,
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(body ? { 'Content-Length': body.length } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function ensureDeviceSession() {
  // Try to refresh existing session first
  if (_deviceSession?.refresh_token) {
    const r = await sbFetch('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: _deviceSession.refresh_token },
    });
    if (r.status === 200 && r.body.access_token) {
      saveDeviceSession({ ..._deviceSession, access_token: r.body.access_token, refresh_token: r.body.refresh_token });
      return _deviceSession;
    }
  }

  // Generate device credentials
  const deviceFile = deviceFilePath();
  let creds;
  try { creds = JSON.parse(fs.readFileSync(deviceFile.replace('.json', '-creds.json'), 'utf8')); } catch {}
  if (!creds) {
    const uid  = require('crypto').randomUUID();
    const pass = require('crypto').randomBytes(24).toString('base64url');
    creds = { email: `device-${uid}@br-device.app`, password: pass };
    try { fs.writeFileSync(deviceFile.replace('.json', '-creds.json'), JSON.stringify(creds)); } catch {}
  }

  // Try sign in, fall back to sign up
  let r = await sbFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: creds });
  if (r.status !== 200) {
    r = await sbFetch('/auth/v1/signup', { method: 'POST', body: creds });
    // After signup, sign in to get tokens (signup may return session directly)
    if (r.status === 200 && !r.body.access_token) {
      r = await sbFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: creds });
    }
  }
  if ((r.status === 200 || r.status === 201) && r.body.access_token) {
    const uid = r.body.user?.id || r.body.id;
    saveDeviceSession({ access_token: r.body.access_token, refresh_token: r.body.refresh_token, user_id: uid, email: creds.email });
    return _deviceSession;
  }
  return null;
}

let pickerWin   = null;
let bubbleWin   = null;
let recorderWin = null;
let annotateWin = null;
let editorWin   = null;
let switcherWin = null;
let regionWin   = null;

// ── Picker ─────────────────────────────────────────────────
function createPicker() {
  pickerWin = new BrowserWindow({
    width: 580, height: 520,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  // Load from userData if available (allows patching without asar repack)
  const pickerHtml = path.join(app.getPath('userData'), 'src', 'picker.html');
  if (fs.existsSync(pickerHtml)) {
    const { pathToFileURL } = require('url');
    pickerWin.loadURL(pathToFileURL(pickerHtml).href);
  } else {
    pickerWin.loadFile('src/picker.html');
  }
  pickerWin.on('closed', () => { pickerWin = null; });
}

// ── Bubble ─────────────────────────────────────────────────
function createBubble(cameraDeviceId) {
  const { workAreaSize } = screen.getPrimaryDisplay();
  bubbleWin = new BrowserWindow({
    width: 164, height: 310,
    x: 24, y: workAreaSize.height - 330,
    transparent: true, frame: false,
    alwaysOnTop: true, resizable: false,
    skipTaskbar: true, hasShadow: false, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  bubbleWin.loadFile('src/bubble.html');
  bubbleWin.setAlwaysOnTop(true, 'screen-saver');
  bubbleWin.setContentProtection(true); // hide from screen recording
  bubbleWin.webContents.once('did-finish-load', () => {
    bubbleWin.webContents.send('init', { cameraDeviceId });
    setTimeout(sendCamPosition, 500); // send initial position after recorder loads
  });
  bubbleWin.on('closed', () => { bubbleWin = null; });
}

// ── Recorder (hidden) ──────────────────────────────────────
function createRecorder(opts) {
  recorderWin = new BrowserWindow({
    width: 400, height: 300, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  recorderWin.loadFile('src/recorder.html');
  recorderWin.webContents.once('did-finish-load', () => {
    recorderWin.webContents.send('start', opts);
  });
  recorderWin.on('closed', () => { recorderWin = null; });
}

// ── Editor ─────────────────────────────────────────────────
function createEditor(filePath) {
  editorWin = new BrowserWindow({
    width: 1100, height: 720,
    minWidth: 800, minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d0d0d',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  const editorHtml = path.join(app.getPath('userData'), 'src', 'editor.html');
  if (fs.existsSync(editorHtml)) {
    const { pathToFileURL } = require('url');
    editorWin.loadURL(pathToFileURL(editorHtml).href);
  } else {
    editorWin.loadFile('src/editor.html');
  }
  editorWin.webContents.once('did-finish-load', () => {
    editorWin.webContents.send('load-video', filePath);
    // Intercept fetch: auto-refresh JWT on 401/403 from Supabase REST
    editorWin.webContents.executeJavaScript(`
      (function() {
        var _orig = window.fetch.bind(window);
        window.fetch = async function(url, opts) {
          var res = await _orig(url, opts);
          if ((res.status === 401 || res.status === 403) &&
              typeof url === 'string' && url.includes('/rest/v1/')) {
            try {
              var session = await window.api.getUserSession();
              if (session && session.access_token) {
                var h = opts && opts.headers ? opts.headers : {};
                if (h instanceof Headers) { var tmp = {}; h.forEach(function(v,k){tmp[k]=v;}); h = tmp; }
                var newOpts = Object.assign({}, opts, { headers: Object.assign({}, h, { Authorization: 'Bearer ' + session.access_token }) });
                return _orig(url, newOpts);
              }
            } catch(e) {}
          }
          return res;
        };
      })();
    `).catch(function() {});
  });
  editorWin.on('closed', () => {
    editorWin = null;
    // Keep the file — it's in ~/Movies/Basic Record/, user can access it
    if (pickerWin) pickerWin.show();
    else createPicker();
  });
}

// ── App ready ──────────────────────────────────────────────
app.whenReady().then(async () => {
  loadDeviceSession();
  loadUserSession();
  ensureDeviceSession().catch(() => {});

  // Request mic permission on first launch so recordings have audio
  if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
    systemPreferences.askForMediaAccess('microphone').catch(() => {});
  }

  createPicker();
  app.on('activate', () => { if (!pickerWin) createPicker(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── IPC: sources ──────────────────────────────────────────
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false,
  });

  function cleanName(raw, isScreen) {
    if (isScreen) return raw.replace(/screen\s*\d*/i, '').trim() || 'Entire Screen';
    // Strip common suffixes added by browsers/apps
    return raw
      .replace(/\s[-–|]\s*(Google Chrome|Chrome|Safari|Firefox|Arc)$/i, '')
      .replace(/\s[-–|]\s*Microsoft Edge$/i, '')
      .replace(/\s[-–|]\s*(Visual Studio Code|VS Code|Code)$/i, ' — VS Code')
      .trim()
      .slice(0, 50) || raw;
  }

  return sources
    .filter(s => s.name !== 'Basic Record' && s.name !== 'Electron')
    .map(s => {
      const isScreen = s.id.startsWith('screen:');
      return { id: s.id, name: cleanName(s.name, isScreen), thumbnail: s.thumbnail.toDataURL(), isScreen };
    });
});

// ── IPC: screen permission check ──────────────────────────
ipcMain.handle('check-screen-permission', () => {
  return systemPreferences.getMediaAccessStatus('screen')
})

ipcMain.handle('check-mic-permission', () => {
  return systemPreferences.getMediaAccessStatus('microphone')
})

// ── IPC: start recording ───────────────────────────────────
let lastRecordingOpts = null;
ipcMain.handle('start-recording', (_, opts) => {
  const perm = systemPreferences.getMediaAccessStatus('screen')
  if (perm !== 'granted') {
    return { error: 'no-permission' }
  }
  lastRecordingOpts = opts;
  pickerWin?.hide();
  createBubble(opts.cameraDeviceId);
  createRecorder(opts);

  // Recording indicator overlay
  if (global._recOverlay) { try { global._recOverlay.destroy() } catch {} }
  global._recOverlay = new BrowserWindow({
    width: 120, height: 40,
    x: 16, y: 16,
    frame: false, transparent: true, alwaysOnTop: true,
    focusable: false, skipTaskbar: true, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  global._recOverlay.setIgnoreMouseEvents(true)
  global._recOverlay.loadURL('data:text/html,' + encodeURIComponent(`
    <html><body style="margin:0;background:rgba(0,0,0,0.65);border-radius:8px;display:flex;align-items:center;gap:6px;padding:6px 12px;font-family:system-ui;color:#fff;font-size:13px;font-weight:600">
      <span style="width:8px;height:8px;background:#ef4444;border-radius:50%;animation:p 1s infinite alternate"></span>
      <span id="t">REC 0:00</span>
      <style>@keyframes p{to{opacity:0.3}}</style>
      <script>
        let s=0;
        setInterval(()=>{s++;const m=Math.floor(s/60),sec=s%60;document.getElementById('t').textContent='REC '+m+':'+(sec<10?'0':'')+sec},1000)
      </script>
    </body></html>
  `))
});

// ── IPC: stop / discard / restart ─────────────────────────
ipcMain.on('stop-recording',    () => recorderWin?.webContents.send('stop'));
ipcMain.on('pause-recording',   (_, v) => recorderWin?.webContents.send('pause', v));
ipcMain.on('discard-recording', () => recorderWin?.webContents.send('discard'));
ipcMain.on('restart-recording', () => {
  if (!lastRecordingOpts) return;
  // Close existing windows directly — skip discard IPC to avoid picker opening
  const opts = lastRecordingOpts;
  annotateWin?.close(); annotateWin = null;
  switcherWin?.close(); switcherWin = null;
  bubbleWin?.destroy();  bubbleWin  = null;
  recorderWin?.destroy(); recorderWin = null;
  if (global._recOverlay) { try { global._recOverlay.destroy() } catch {} global._recOverlay = null }
  setTimeout(() => {
    createBubble(opts.cameraDeviceId);
    createRecorder(opts);
  }, 200);
});

// ── IPC: save temp file → open editor ─────────────────────
// ── IPC: streaming temp file (write chunks as they arrive) ──
let _streamPath = null;
function getRecordingsDir() {
  const dir = path.join(app.getPath('home'), 'Movies', 'Basic Record');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

ipcMain.handle('create-temp-file', () => {
  _streamPath = path.join(getRecordingsDir(), `br-${Date.now()}.webm`);
  fs.writeFileSync(_streamPath, Buffer.alloc(0));
  return _streamPath;
});
ipcMain.handle('append-chunk', (_, arrayBuf) => {
  if (!_streamPath) return;
  try { fs.appendFileSync(_streamPath, Buffer.from(arrayBuf)); } catch {}
});
ipcMain.handle('save-temp', async (_, arrayBuf) => {
  // Fallback: if streaming was used, file already exists; else write now
  if (_streamPath && fs.existsSync(_streamPath) && fs.statSync(_streamPath).size > 0) {
    const p = _streamPath; _streamPath = null; return p;
  }
  const tmpPath = path.join(os.tmpdir(), `br-${Date.now()}.webm`);
  fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));
  _streamPath = null;
  return tmpPath;
});

// ── IPC: open existing file in editor ─────────────────────
ipcMain.on('pick-recording', (_, filePath) => {
  pickerWin?.hide();
  createEditor(filePath);
});

ipcMain.handle('list-recordings', async () => {
  const fs = require('fs');
  const dir = path.join(app.getPath('home'), 'Movies', 'Basic Record');
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /\.(webm|mp4|mov)$/i.test(f))
      .map(f => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files;
  } catch { return []; }
});

ipcMain.handle('open-recording-file', async (_, filePath) => {
  pickerWin?.hide();
  createEditor(filePath);
});

ipcMain.handle('open-existing-file', async () => {
  const dir = path.join(app.getPath('home'), 'Movies', 'Basic Record');
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => /\.(webm|mp4|mov)$/i.test(f))
      .map(f => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}

  const rows = files.map(f => {
    const d = new Date(f.mtime);
    const date = d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }) + ' ' +
                 d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const size = f.size > 1e9 ? (f.size/1e9).toFixed(1)+' GB' : f.size > 1e6 ? (f.size/1e6).toFixed(0)+' MB' : (f.size/1e3).toFixed(0)+' KB';
    const safePath = f.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `<button onclick="pick('${safePath}')" style="display:flex;align-items:center;gap:12px;width:100%;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:9px;padding:10px 14px;cursor:pointer;text-align:left;margin-bottom:6px;" onmouseover="this.style.borderColor='#ef4444'" onmouseout="this.style.borderColor='#2a2a2a'">
      <span style="font-size:18px">🎥</span>
      <span style="flex:1;overflow:hidden">
        <span style="display:block;font-size:12px;font-weight:600;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.name}</span>
        <span style="display:block;font-size:11px;color:#555;margin-top:2px">${date} · ${size}</span>
      </span>
      <span style="font-size:11px;color:#444">▶</span>
    </button>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box} body{background:#111;color:#fff;font-family:-apple-system,sans-serif;padding:20px;-webkit-app-region:drag}
    .inner{-webkit-app-region:no-drag}
    h2{font-size:13px;font-weight:700;color:#ccc;margin-bottom:14px}
    .list{max-height:400px;overflow-y:auto}
    .empty{color:#444;font-size:12px;padding:20px 0}
  </style></head><body>
  <div class="inner">
    <h2>🎥 Movies / Basic Record</h2>
    <div class="list">${rows || '<div class="empty">No recordings found</div>'}</div>
  </div>
  <script>
    const {ipcRenderer} = require('electron');
    function pick(p){ ipcRenderer.send('pick-recording', p); window.close(); }
  </script>
  </body></html>`;

  const win = new BrowserWindow({
    width: 480, height: 480,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
});

ipcMain.on('open-editor', (_, filePath) => {
  bubbleWin?.close();
  recorderWin?.close();
  annotateWin?.close();
  if (global._recOverlay) { try { global._recOverlay.destroy() } catch {} global._recOverlay = null }
  createEditor(filePath);
});

// ── IPC: discard done ─────────────────────────────────────
ipcMain.on('recording-discarded', () => {
  bubbleWin?.close();
  recorderWin?.close();
  pickerWin?.show();
  if (!pickerWin) createPicker();
});

// ── IPC: get save path for export ─────────────────────────
ipcMain.handle('get-save-path', async () => {
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const defaultPath = path.join(app.getPath('downloads'), `basic-record-${ts}.webm`);
  const { filePath, canceled } = await dialog.showSaveDialog(editorWin, {
    defaultPath,
    filters: [{ name: 'Video', extensions: ['webm'] }],
  });
  if (canceled || !filePath) return null;
  return filePath;
});

// ── IPC: read file for audio extraction ──────────────────
ipcMain.handle('read-file', (_, fp) => {
  try { return Array.from(new Uint8Array(fs.readFileSync(fp))); }
  catch { return null; }
});
// ── User session (real login, stored separately from device session) ──
let _userSession = null;
function userSessionPath() { return path.join(app.getPath('userData'), 'user-session.json'); }
function loadUserSession() {
  try { _userSession = JSON.parse(fs.readFileSync(userSessionPath(), 'utf8')); } catch {}
}
function saveUserSession(s) {
  _userSession = s;
  try { fs.writeFileSync(userSessionPath(), JSON.stringify(s)); } catch {}
}

ipcMain.handle('user-login', async (_, { email, password, isSignup }) => {
  try {
    const endpoint = isSignup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
    let r = await sbFetch(endpoint, { method: 'POST', body: { email, password } });
    // After signup, sign in to get tokens
    if (isSignup && r.status === 200 && !r.body.access_token) {
      r = await sbFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    }
    if ((r.status === 200 || r.status === 201) && r.body.access_token) {
      const session = {
        access_token: r.body.access_token,
        refresh_token: r.body.refresh_token,
        user_id: r.body.user?.id,
        email,
      };
      saveUserSession(session);
      return { ok: true };
    }
    const msg = r.body?.error_description || r.body?.msg || r.body?.message || 'Login failed';
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-user-session', async () => {
  // Try to refresh user session if it exists
  if (_userSession?.refresh_token) {
    const r = await sbFetch('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: _userSession.refresh_token },
    });
    if (r.status === 200 && r.body.access_token) {
      saveUserSession({ ..._userSession, access_token: r.body.access_token, refresh_token: r.body.refresh_token });
      return _userSession;
    }
    // Refresh failed — clear stored session
    _userSession = null;
    try { fs.unlinkSync(userSessionPath()); } catch {}
    return null;
  }
  return _userSession || null;
});

ipcMain.handle('user-logout', () => {
  _userSession = null;
  try { fs.unlinkSync(userSessionPath()); } catch {}
  return { ok: true };
});

ipcMain.handle('get-device-session', async () => {
  // Prefer real user session over anonymous device session
  if (_userSession?.access_token) return _userSession;
  const s = await ensureDeviceSession();
  return s;
});

ipcMain.handle('get-file-size', (_, fp) => {
  try { return fs.statSync(fp).size; } catch { return 0; }
});
ipcMain.handle('read-file-chunk', (_, fp, start, len) => {
  let fd;
  try {
    const buf = Buffer.alloc(len);
    fd = fs.openSync(fp, 'r');
    const read = fs.readSync(fd, buf, 0, len, start);
    return buf.buffer.slice(0, read);
  } catch { return null; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch {} }
});

// ── IPC: streaming export (chunks go to disk as they arrive) ──
let _exportPath = null;
ipcMain.handle('export-stream-open', (_, fp) => {
  _exportPath = fp;
  fs.writeFileSync(fp, Buffer.alloc(0));
  return fp;
});
ipcMain.handle('export-stream-write', (_, arrayBuf) => {
  if (!_exportPath) return;
  try { fs.appendFileSync(_exportPath, Buffer.from(arrayBuf)); } catch {}
});
ipcMain.handle('export-stream-close', () => {
  const p = _exportPath; _exportPath = null;
  if (p) shell.showItemInFolder(p);
  return p;
});

// ── IPC: write exported file (legacy fallback) ──────────────
ipcMain.handle('write-export', async (_, { filePath, buffer }) => {
  try {
    fs.writeFileSync(filePath, Buffer.from(buffer));
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Keep old handler for backward compat
ipcMain.handle('export-video', async (_, { buffer }) => {
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const defaultPath = path.join(app.getPath('downloads'), `basic-record-${ts}.webm`);
  const { filePath, canceled } = await dialog.showSaveDialog(editorWin, {
    defaultPath,
    filters: [{ name: 'Video', extensions: ['webm'] }],
  });
  if (canceled || !filePath) return { ok: false };
  const buf = Array.isArray(buffer) ? Buffer.from(buffer) : Buffer.from(new Uint8Array(buffer));
  fs.writeFileSync(filePath, buf);
  shell.showItemInFolder(filePath);
  return { ok: true, filePath };
});

// ── IPC: renderer override loader ─────────────────────────
ipcMain.handle('load-renderer-override', (_, name) => {
  const p = path.join(app.getPath('userData'), `${name}-override.js`);
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return null; }
});

// ── IPC: editor done → back to picker ─────────────────────
ipcMain.on('open-external', (_, url) => { shell.openExternal(url); });

ipcMain.on('editor-done', () => {
  editorWin?.close();
  pickerWin?.show();
  if (!pickerWin) createPicker();
});

// ── IPC: bubble drag & resize ─────────────────────────────
function sendCamPosition() {
  if (!bubbleWin || !recorderWin) return;
  const { bounds } = screen.getPrimaryDisplay();
  const [bx, by] = bubbleWin.getPosition();
  const [bw]     = bubbleWin.getSize();
  // Camera circle center is ~bw/2 horizontally, ~(12 + bubbleSize/2) from top
  const camCx = bx + bw / 2;
  const camCy = by + 82; // approx center of 140px bubble
  recorderWin.webContents.send('cam-position-xy', {
    x: Math.max(0.05, Math.min(0.95, camCx / bounds.width)),
    y: Math.max(0.05, Math.min(0.95, camCy / bounds.height)),
  });
}

ipcMain.on('bubble-drag', (_, { dx, dy }) => {
  if (!bubbleWin) return;
  const [x, y] = bubbleWin.getPosition();
  bubbleWin.setPosition(x + dx, y + dy);
  sendCamPosition();
});
ipcMain.on('resize-bubble', (_, { width, height }) => {
  if (!bubbleWin) return;
  const { workAreaSize } = screen.getPrimaryDisplay();
  const [x] = bubbleWin.getPosition();
  const h = Math.min(height, workAreaSize.height - 40);
  bubbleWin.setSize(width, h);
  bubbleWin.setPosition(x, Math.max(20, workAreaSize.height - h - 20));
  sendCamPosition();
});

// ── IPC: timer ────────────────────────────────────────────
ipcMain.on('timer-tick', (_, s) => bubbleWin?.webContents.send('timer-tick', s));
ipcMain.on('flip-camera', (_, v) => recorderWin?.webContents.send('flip-camera', v));
ipcMain.on('cam-position', (_, pos) => recorderWin?.webContents.send('cam-position', pos));
ipcMain.on('cam-out-of-bounds', (_, v) => bubbleWin?.webContents.send('cam-out-of-bounds', v));
ipcMain.on('cam-visible', (_, v) => recorderWin?.webContents.send('cam-visible', v));
ipcMain.on('cam-size',    (_, r) => recorderWin?.webContents.send('cam-size', r));

// ── IPC: source switcher ──────────────────────────────────
ipcMain.on('open-source-switcher', () => {
  if (switcherWin) { switcherWin.focus(); return; }
  switcherWin = new BrowserWindow({
    width: 480, height: 360,
    alwaysOnTop: true, resizable: false,
    titleBarStyle: 'hiddenInset', backgroundColor: '#111',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  switcherWin.loadFile('src/switcher.html');
  switcherWin.on('closed', () => { switcherWin = null; });
});
ipcMain.on('annotation-frame', (_, dataUrl) => {
  recorderWin?.webContents.send('annotation-frame', dataUrl);
});

ipcMain.on('switch-source-chosen', async (_, sourceId) => {
  switcherWin?.close(); switcherWin = null;
  recorderWin?.webContents.send('switch-source', sourceId);
  // Notify bubble with source name
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } });
    const src = sources.find(s => s.id === sourceId);
    if (src && bubbleWin) bubbleWin.webContents.send('source-switched', src.name.slice(0, 40));
  } catch {}
});

// ── IPC: region selector ──────────────────────────────────
let regionResolve = null;
ipcMain.handle('select-region', () => new Promise(resolve => {
  regionResolve = resolve;
  const { bounds } = screen.getPrimaryDisplay();
  regionWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true, frame: false, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  regionWin.loadFile('src/region.html');
  regionWin.setAlwaysOnTop(true, 'screen-saver');
  regionWin.on('closed', () => { regionWin = null; if (regionResolve) { regionResolve(null); regionResolve = null; } });
}));
ipcMain.on('region-selected', (_, rect) => {
  regionWin?.close(); regionWin = null;
  if (regionResolve) { regionResolve(rect); regionResolve = null; }
});

// ── IPC: annotation overlay ───────────────────────────────
function clearAnnotationOverlay() {
  recorderWin?.webContents.send('annotation-frame', null);
}

ipcMain.on('toggle-annotation', () => {
  if (annotateWin) {
    annotateWin.close(); annotateWin = null;
    bubbleWin?.webContents.send('annotate-closed');
    clearAnnotationOverlay();
    return;
  }
  const { bounds } = screen.getPrimaryDisplay();
  annotateWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true, frame: false, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  annotateWin.loadFile('src/annotate.html');
  annotateWin.setAlwaysOnTop(true, 'screen-saver');
  annotateWin.on('closed', () => {
    annotateWin = null;
    bubbleWin?.webContents.send('annotate-closed');
    clearAnnotationOverlay();
  });
});
