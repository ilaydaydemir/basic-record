const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, shell, screen } = require('electron');
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
  pickerWin.loadFile('src/picker.html');
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
  editorWin.loadFile('src/editor.html');
  editorWin.webContents.once('did-finish-load', () => {
    editorWin.webContents.send('load-video', filePath);
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
  ensureDeviceSession().catch(() => {}); // background, don't block startup
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
    .filter(s => !['Basic Record', 'Electron'].some(n => s.name.includes(n)))
    .map(s => {
      const isScreen = s.id.startsWith('screen:');
      return { id: s.id, name: cleanName(s.name, isScreen), thumbnail: s.thumbnail.toDataURL(), isScreen };
    });
});

// ── IPC: start recording ───────────────────────────────────
let lastRecordingOpts = null;
ipcMain.handle('start-recording', (_, opts) => {
  lastRecordingOpts = opts;
  pickerWin?.hide();
  createBubble(opts.cameraDeviceId);
  createRecorder(opts);
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
ipcMain.handle('open-existing-file', async () => {
  const { filePath, canceled } = await dialog.showOpenDialog(pickerWin || editorWin, {
    filters: [{ name: 'Video', extensions: ['webm', 'mp4', 'mov'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePath?.[0]) return;
  pickerWin?.hide();
  createEditor(filePath[0]);
});

ipcMain.on('open-editor', (_, filePath) => {
  bubbleWin?.close();
  recorderWin?.close();
  annotateWin?.close();
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
ipcMain.handle('get-device-session', async () => {
  const s = await ensureDeviceSession();
  return s;
});

ipcMain.handle('get-file-size', (_, fp) => {
  try { return fs.statSync(fp).size; } catch { return 0; }
});
ipcMain.handle('read-file-chunk', (_, fp, start, len) => {
  try {
    const buf = Buffer.alloc(len);
    const fd  = fs.openSync(fp, 'r');
    const read = fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.buffer.slice(0, read);
  } catch { return null; }
});

// ── IPC: write exported file ────────────────────────────────
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
