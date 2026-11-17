'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, v) => fn(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('mirror', {
  init: () => ipcRenderer.invoke('init'),
  displays: () => ipcRenderer.invoke('displays'),
  approve: () => ipcRenderer.send('approve'),
  reject: () => ipcRenderer.send('reject'),
  stop: () => ipcRenderer.send('stop'),
  keyframe: () => ipcRenderer.send('keyframe'),
  newCode: () => ipcRenderer.send('new-code'),
  fullscreen: (v) => ipcRenderer.send('fullscreen', v),
  setDisplay: (id) => ipcRenderer.send('set-display', id),
  saveSettings: (patch) => ipcRenderer.send('settings', patch),
  onState: on('state'),
  onNotice: on('notice'),
  onDisplays: on('displays'),
  onVideoConfig: on('video-config'),
  onVideo: on('video'),
  onAudioConfig: on('audio-config'),
  onAudio: on('audio'),
  onAudioStatus: on('audio-status'),
});
