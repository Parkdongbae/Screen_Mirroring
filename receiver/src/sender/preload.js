'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (fn) => ipcRenderer.on(ch, (_e, v) => fn(v));

contextBridge.exposeInMainWorld('sender', {
  init: () => ipcRenderer.invoke('init'),
  connect: (opts) => ipcRenderer.send('connect', opts),
  stop: () => ipcRenderer.send('stop'),
  setDisplay: (id) => ipcRenderer.send('set-display', id),
  openNotifications: () => ipcRenderer.send('open-notifications'),
  minimize: () => ipcRenderer.send('minimize'),
  captureStarted: (info) => ipcRenderer.send('capture-started', info),
  captureFailed: (msg) => ipcRenderer.send('capture-failed', msg),
  videoConfig: (c) => ipcRenderer.send('video-config', c),
  audioConfig: (c) => ipcRenderer.send('audio-config', c),
  video: (buf, key, pts) => ipcRenderer.invoke('video', buf, key, pts),
  audio: (buf, pts) => ipcRenderer.send('audio', buf, pts),
  onState: on('state'),
  onStartCapture: on('start-capture'),
  onStopCapture: on('stop-capture'),
  onKeyframe: on('keyframe'),
  onMode: on('mode'),
  onAudioMute: on('audio-mute'),
});
