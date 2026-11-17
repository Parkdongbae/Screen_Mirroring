'use strict';
// 개발용 가짜 송신기: Android 앱 대신 시험 영상(H.264)과 440Hz 소리를 보낸다.
//   electron test/fake-sender.js <코드> [호스트] [포트]
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const w = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.js') && a !== '.');
  w.loadFile(path.join(__dirname, 'fake-sender.html'), { query: { code: args[0] || '123456', host: args[1] || '127.0.0.1', port: args[2] || '47600' } });
  w.webContents.on('console-message', (_e, _l, msg) => console.log('[sender]', msg));
});
