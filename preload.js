const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Picker
  getSources:         ()       => ipcRenderer.invoke('get-sources'),
  startRecording:     (opts)   => ipcRenderer.invoke('start-recording', opts),
  selectRegion:       ()       => ipcRenderer.invoke('select-region'),
  checkScreenPermission: ()    => ipcRenderer.invoke('check-screen-permission'),

  // Recorder → editor flow
  createTempFile:     ()       => ipcRenderer.invoke('create-temp-file'),
  appendChunk:        (buf)    => ipcRenderer.invoke('append-chunk', buf),
  saveTemp:           (buf)    => ipcRenderer.invoke('save-temp', buf),
  openEditor:         (fp)     => ipcRenderer.send('open-editor', fp),
  recordingDiscarded: ()       => ipcRenderer.send('recording-discarded'),
  onStart:            (cb)     => ipcRenderer.on('start',         (_, d) => cb(d)),
  onStop:             (cb)     => ipcRenderer.on('stop',          ()     => cb()),
  onPause:            (cb)     => ipcRenderer.on('pause',         (_, v) => cb(v)),
  onDiscard:          (cb)     => ipcRenderer.on('discard',       ()     => cb()),
  onSwitchSource:     (cb)     => ipcRenderer.on('switch-source', (_, d) => cb(d)),

  // Bubble controls
  stopRecording:      ()       => ipcRenderer.send('stop-recording'),
  pauseRecording:     (v)      => ipcRenderer.send('pause-recording', v),
  restartRecording:   ()       => ipcRenderer.send('restart-recording'),
  discardRecording:   ()       => ipcRenderer.send('discard-recording'),
  bubbleDrag:         (d)      => ipcRenderer.send('bubble-drag', d),
  resizeBubble:       (sz)     => ipcRenderer.send('resize-bubble', sz),
  timerTick:          (s)      => ipcRenderer.send('timer-tick', s),
  toggleAnnotation:   ()       => ipcRenderer.send('toggle-annotation'),
  flipCamera:         (v)      => ipcRenderer.send('flip-camera', v),
  onFlipCamera:       (cb)     => ipcRenderer.on('flip-camera', (_, v) => cb(v)),
  setCamPosition:     (pos)    => ipcRenderer.send('cam-position', pos),
  onCamPosition:      (cb)     => ipcRenderer.on('cam-position', (_, pos) => cb(pos)),
  onCamPositionXY:    (cb)     => ipcRenderer.on('cam-position-xy', (_, pos) => cb(pos)),
  setCamVisible:        (v)   => ipcRenderer.send('cam-visible', v),
  setCamSize:           (r)   => ipcRenderer.send('cam-size', r),
  onCamSize:            (cb)  => ipcRenderer.on('cam-size', (_, r) => cb(r)),
  onCamVisible:         (cb)  => ipcRenderer.on('cam-visible', (_, v) => cb(v)),
  notifyCamOutOfBounds: (v)   => ipcRenderer.send('cam-out-of-bounds', v),
  onCamOutOfBounds:   (cb)     => ipcRenderer.on('cam-out-of-bounds', (_, v) => cb(v)),
  openSourceSwitcher: ()       => ipcRenderer.send('open-source-switcher'),
  onInit:             (cb)     => ipcRenderer.on('init',           (_, d) => cb(d)),
  onTimerTick:        (cb)     => ipcRenderer.on('timer-tick',     (_, s) => cb(s)),
  onAnnotateClosed:   (cb)     => ipcRenderer.on('annotate-closed',()     => cb()),
  onSourceSwitched:   (cb)     => ipcRenderer.on('source-switched',  (_, name) => cb(name)),

  // Annotation (live)
  sendAnnotationFrame:(data)   => ipcRenderer.send('annotation-frame', data),
  onAnnotationFrame:  (cb)     => ipcRenderer.on('annotation-frame', (_, d) => cb(d)),
  notifySwitchSource: (id)     => ipcRenderer.send('switch-source-chosen', id),
  regionSelected:     (rect)   => ipcRenderer.send('region-selected', rect),

  // Auth
  userLogin:          (opts)   => ipcRenderer.invoke('user-login', opts),
  getUserSession:     ()       => ipcRenderer.invoke('get-user-session'),
  userLogout:         ()       => ipcRenderer.invoke('user-logout'),

  // Storage upload (main-process streaming — no large buffers in renderer)
  uploadRecording:    (opts)   => ipcRenderer.invoke('upload-recording', opts),
  uploadBlobBegin:    ()       => ipcRenderer.invoke('upload-blob-begin'),
  uploadBlobChunk:    (buf)    => ipcRenderer.invoke('upload-blob-chunk', buf),
  uploadBlobFinish:   (opts)   => ipcRenderer.invoke('upload-blob-finish-exec', opts),

  // Editor
  readFile:           (fp)     => ipcRenderer.invoke('read-file', fp),
  getDeviceSession:   ()       => ipcRenderer.invoke('get-device-session'),
  openExistingFile:   ()       => ipcRenderer.invoke('open-existing-file'),
  listRecordings:     ()       => ipcRenderer.invoke('list-recordings'),
  openRecordingFile:  (fp)     => ipcRenderer.invoke('open-recording-file', fp),
  blobUpload:         (opts)   => ipcRenderer.invoke('blob-upload', opts),
  blobUploadBuffer:   (opts)   => ipcRenderer.invoke('blob-upload-buffer', opts),
  onBlobUploadProgress: (cb)   => ipcRenderer.on('blob-upload-progress', (_, d) => cb(d)),
  getFileSize:        (fp)     => ipcRenderer.invoke('get-file-size', fp),
  readFileChunk:      (fp, s, l) => ipcRenderer.invoke('read-file-chunk', fp, s, l),
  exportVideo:        (data)   => ipcRenderer.invoke('export-video', data),
  getSavePath:        ()       => ipcRenderer.invoke('get-save-path'),
  exportStreamOpen:   (fp)     => ipcRenderer.invoke('export-stream-open', fp),
  exportStreamWrite:  (buf)    => ipcRenderer.invoke('export-stream-write', buf),
  exportStreamClose:  ()       => ipcRenderer.invoke('export-stream-close'),
  writeExport:        (data)   => ipcRenderer.invoke('write-export', data),
  editorDone:         ()       => ipcRenderer.send('editor-done'),
  openExternal:       (url)    => ipcRenderer.send('open-external', url),
  onLoadVideo:        (cb)     => ipcRenderer.on('load-video', (_, fp) => cb(fp)),
  loadRendererOverride: (name) => ipcRenderer.invoke('load-renderer-override', name),
});
