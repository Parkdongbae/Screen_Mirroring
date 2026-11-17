'use strict';

const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { ReceiverServer } = require('./server');

// 개발 중에는 설치된 수신기와 겹치지 않게 설정 폴더를 따로 쓸 수 있다.
if (!app.isPackaged && process.env.SMIRROR_USER_DATA) app.setPath('userData', process.env.SMIRROR_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// 교사가 화면을 누르지 않아도 휴대전화 소리가 바로 재생되게 한다.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const userDir = () => app.getPath('userData');

// ---- 설정 ----
const DEFAULT_SETTINGS = { displayId: null, audioDeviceId: 'default', volume: 1, muted: false, mode: 'stable', pcName: os.hostname() };
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(path.join(userDir(), 'settings.json'), 'utf8')) };
  } catch {}
}

function saveSettings() {
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(path.join(userDir(), 'settings.json'), JSON.stringify(settings, null, 2));
  } catch {}
}

// ---- 인증서(첫 실행 때 만들고 계속 사용) ----
async function loadCert() {
  const file = path.join(userDir(), 'cert.json');
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.cert && c.key) return withFingerprint(c);
  } catch {}
  const selfsigned = require('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'screen-mirror-receiver' }], {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
  });
  const c = { cert: pems.cert, key: pems.private };
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c));
  return withFingerprint(c);
}

function withFingerprint(c) {
  const x = new crypto.X509Certificate(c.cert);
  return { ...c, fingerprint: x.fingerprint256.replace(/:/g, '').toLowerCase() };
}

// ---- 창 ----
let win = null;
let server = null;
let blockerId = null;
let lastState = null;

function targetDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === settings.displayId) || screen.getPrimaryDisplay();
}

function createWindow() {
  const d = targetDisplay();
  win = new BrowserWindow({
    x: d.bounds.x + 40,
    y: d.bounds.y + 40,
    width: Math.min(1280, d.workArea.width - 80),
    height: Math.min(800, d.workArea.height - 80),
    backgroundColor: '#0f172a',
    title: '화면 미러링 수신기',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function pushState(state) {
  let qr = null;
  if (state.code) {
    qr = await QRCode.toDataURL(state.uri, { errorCorrectionLevel: 'M', margin: 1, scale: 10 });
  }
  lastState = { ...state, qr };
  send('state', lastState);
  updatePowerBlocker(state.sessions.some((x) => x.state === 'waiting' || x.state === 'streaming'));
}

// 공유 중에는 PC가 절전·화면 꺼짐으로 바뀌지 않게 한다(FR-15).
function updatePowerBlocker(active) {
  if (active && blockerId === null) blockerId = powerSaveBlocker.start('prevent-display-sleep');
  if (!active && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

function moveToDisplay(id, fullscreen) {
  if (!win) return;
  const d = screen.getAllDisplays().find((x) => x.id === id) || screen.getPrimaryDisplay();
  const wasFull = win.isFullScreen();
  if (wasFull) win.setFullScreen(false);
  win.setBounds({ x: d.workArea.x + 40, y: d.workArea.y + 40, width: Math.min(1280, d.workArea.width - 80), height: Math.min(800, d.workArea.height - 80) });
  if (fullscreen ?? wasFull) setTimeout(() => win && win.setFullScreen(true), 150);
}

function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `${i + 1}번 화면${d.label ? ` (${d.label})` : ''} ${d.size.width}×${d.size.height}${d.id === primary ? ' · 주 모니터' : ''}`,
    current: d.id === targetDisplay().id,
  }));
}

// ---- IPC ----
function setupIpc() {
  ipcMain.handle('init', () => ({ settings, displays: displayList(), state: lastState }));
  ipcMain.on('approve', (_e, id) => server.approve(id));
  ipcMain.on('approve-all', () => server.approveAll());
  ipcMain.on('reject', (_e, id) => server.reject(id, 'rejected'));
  ipcMain.on('stop', (_e, id) => server.endSession(id, 'user'));
  ipcMain.on('stop-all', () => server.endAll());
  ipcMain.on('mute', (_e, id, muted) => server.setMuted(id, muted, 'teacher'));
  ipcMain.on('mute-all', () => server.muteAll());
  ipcMain.on('keyframe', (_e, id) => server.requestKeyframe(id));
  ipcMain.on('new-code', () => server.newCode());
  ipcMain.on('fullscreen', (_e, v) => win && win.setFullScreen(v ?? !win.isFullScreen()));
  ipcMain.handle('displays', () => displayList());
  ipcMain.on('set-display', (_e, id) => {
    settings.displayId = id;
    saveSettings();
    moveToDisplay(id, true);
  });
  ipcMain.on('settings', (_e, patch) => {
    const allowed = ['audioDeviceId', 'volume', 'muted', 'mode', 'pcName'];
    for (const k of allowed) if (k in patch) settings[k] = patch[k];
    saveSettings();
    if ('mode' in patch) server.setMode(settings.mode);
  });
}

async function main() {
  loadSettings();
  const cert = await loadCert();
  server = new ReceiverServer({
    ...cert,
    pcName: settings.pcName,
    mode: settings.mode,
    port: !app.isPackaged && process.env.SMIRROR_PORT ? Number(process.env.SMIRROR_PORT) : undefined,
  });
  server.on('state', (s) => pushState(s));
  server.on('notice', (n) => send('notice', n));
  server.on('ended', (e) => send('notice', { level: 'info', text: e.text }));
  server.on('video-config', (c) => send('video-config', c));
  server.on('video', (v) => send('video', { id: v.id, data: v.data, key: v.key, pts: Number(v.pts) }));
  server.on('audio-config', (c) => send('audio-config', c));
  server.on('audio', (a) => send('audio', a));
  setupIpc();
  createWindow();
  try {
    await server.start();
  } catch (err) {
    send('notice', { level: 'error', text: `수신 포트를 열 수 없습니다(${err.code || err.message}).` });
  }
  if (!app.isPackaged) setupDevHooks();
  screen.on('display-added', () => send('displays', displayList()));
  screen.on('display-removed', () => send('displays', displayList()));
}

// 개발용 자동 시험 장치(설치본에서는 동작하지 않음)
//   SMIRROR_DEV_CODE=123456   접속 코드 고정
//   SMIRROR_AUTO_APPROVE=1    연결 요청 자동 승인
//   SMIRROR_SHOTS=dir         공유 화면을 주기적으로 캡처
function setupDevHooks() {
  const env = process.env;
  if (env.SMIRROR_DEV_CODE) {
    const force = () => {
      if (server.code !== env.SMIRROR_DEV_CODE) {
        server.code = env.SMIRROR_DEV_CODE;
        server._emitState();
      }
    };
    force();
    server.on('state', force);
  }
  if (env.SMIRROR_AUTO_APPROVE) {
    server.on('state', (s) => s.sessions.some((x) => x.state === 'request') && setTimeout(() => server.approveAll(), Number(env.SMIRROR_AUTO_APPROVE) > 1 ? Number(env.SMIRROR_AUTO_APPROVE) : 300));
  }
  if (env.SMIRROR_STATS) {
    win?.webContents.on('console-message', (e) => console.log(e.message ?? e));
    const c = { video: 0, key: 0, audio: 0, audioBytes: 0 };
    server.on('video', (v) => { c.video++; if (v.key) c.key++; });
    server.on('audio', (a) => { c.audio++; c.audioBytes += a.data.length; });
    server.on('audio-config', (a) => console.log('[stats] audio-config', JSON.stringify(a)));
    server.on('video-config', (v) => console.log('[stats] video-config', JSON.stringify(v)));
    setInterval(() => {
      const st = (lastState?.sessions || []).map((x) => `${x.id}:${x.state}${x.muted ? '(음소거)' : ''}`).join(',');
      console.log(`[stats] sessions=[${st}] video=${c.video} key=${c.key} audio=${c.audio} audioKB=${(c.audioBytes / 1024) | 0}`);
      Object.assign(c, { video: 0, key: 0, audio: 0, audioBytes: 0 });
    }, 2000);
  }
  if (env.SMIRROR_SHOTS) {
    fs.mkdirSync(env.SMIRROR_SHOTS, { recursive: true });
    let n = 0;
    setInterval(async () => {
      if (!win) return;
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(env.SMIRROR_SHOTS, `shot-${String(n++).padStart(2, '0')}-${lastState?.sessions?.length || 0}.png`), img.toPNG());
    }, 1500);
  }
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(main);
app.on('window-all-closed', () => {
  server?.stop();
  app.quit();
});
