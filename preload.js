const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Picker
  getSources:         ()       => ipcRenderer.invoke('get-sources'),
  startRecording:     (opts)   => ipcRenderer.invoke('start-recording', opts),
  selectRegion:       ()       => ipcRenderer.invoke('select-region'),

  // Recorder → editor flow
  saveTemp:           (data)   => ipcRenderer.invoke('save-temp', data),
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
  togglePreview:      ()       => ipcRenderer.send('toggle-preview'),
  openEditorFile:     (fp)     => ipcRenderer.send('open-editor-file', fp),
  onRecordingSaved:   (cb)     => ipcRenderer.on('recording-saved',   (_, fp)  => cb(fp)),
  onPreviewClosed:    (cb)     => ipcRenderer.on('preview-closed',    ()       => cb()),

  // Annotation (live)
  sendAnnotationFrame:(data)   => ipcRenderer.send('annotation-frame', data),
  onAnnotationFrame:  (cb)     => ipcRenderer.on('annotation-frame', (_, d) => cb(d)),
  notifySwitchSource: (id)     => ipcRenderer.send('switch-source-chosen', id),
  regionSelected:     (rect)   => ipcRenderer.send('region-selected', rect),

  // Editor
  readFile:           (fp)     => ipcRenderer.invoke('read-file', fp),
  exportVideo:        (data)   => ipcRenderer.invoke('export-video', data),
  getSavePath:        ()       => ipcRenderer.invoke('get-save-path'),
  writeExport:        (data)   => ipcRenderer.invoke('write-export', data),
  editorDone:         ()       => ipcRenderer.send('editor-done'),
  openExternal:       (url)    => ipcRenderer.send('open-external', url),
  onLoadVideo:        (cb)     => ipcRenderer.on('load-video', (_, fp) => cb(fp)),
});
