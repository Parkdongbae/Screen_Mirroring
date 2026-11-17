'use strict';
// 학생 노트북(Windows 11)용 화면 보내기 프로그램의 메인 프로세스.
// 화면·소리 캡처와 인코딩은 화면(renderer)에서 하고, 여기서는 PC 찾기·TLS 연결·전송을 맡는다.

const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tls = require('tls');
const dgram = require('dgram');
const { PROTO_VERSION, T, FLAG_KEY, encode, FrameParser, parseJson } = require('../protocol');

const TLS_PORT = 47600;
const DISCOVERY_PORT = 47601;

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let conn = null; // { socket, state, pcName }
let settings = { name: os.userInfo().username || os.hostname(), audio: true, displayId: null, pins: {} };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {}
}
function saveSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {}
}

function send(ch, v) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, v);
}

function setState(state, message, extra = {}) {
  if (conn) conn.state = state;
  // 공유 중에는 이 창이 칠판에 보이지 않게 캡처에서 제외한다.
  if (win) win.setContentProtection(state === 'streaming' || state === 'consent');
  send('state', { state, message, pcName: conn?.pcName || '', ...extra });
}

// ---------- PC 찾기 ----------

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

function discover(code, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const msg = Buffer.from(JSON.stringify({ t: 'disc', code }));
    let timer;
    let tick;
    const done = (v) => {
      clearTimeout(timer);
      clearInterval(tick);
      try { sock.close(); } catch {}
      resolve(v);
    };
    sock.on('error', () => done(null));
    sock.on('message', (buf, rinfo) => {
      const r = parseJson(buf);
      if (!r || r.t !== 'here' || r.code !== code || !/^[0-9a-f]{64}$/.test(r.fp || '')) return;
      done({ hosts: [rinfo.address], port: r.port || TLS_PORT, fp: r.fp, pcName: r.name || '교실 PC' });
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const blast = () => broadcastAddresses().forEach((a) => sock.send(msg, DISCOVERY_PORT, a, () => {}));
      blast();
      tick = setInterval(blast, 500);
      timer = setTimeout(() => done(null), timeoutMs);
    });
  });
}

// ---------- 연결 ----------

function tryConnect(host, port, expectedFp) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, rejectUnauthorized: false, timeout: 3000, minVersion: 'TLSv1.2' });
    const fail = (why) => {
      s.destroy();
      resolve({ error: why });
    };
    s.once('timeout', () => fail('unreachable'));
    s.once('error', () => fail('unreachable'));
    s.once('secureConnect', () => {
      const fp = (s.getPeerCertificate().fingerprint256 || '').replace(/:/g, '').toLowerCase();
      if (expectedFp && fp !== expectedFp) return fail('mismatch');
      s.setTimeout(0);
      s.removeAllListeners('error');
      s.removeAllListeners('timeout');
      resolve({ socket: s, fp });
    });
  });
}

const REJECT_TEXT = {
  rejected: '선생님 PC에서 연결을 거절했습니다.',
  busy: '선생님 PC가 이미 다른 화면을 표시하고 있습니다. 공유가 끝난 뒤 다시 시도해 주세요.',
  badcode: '접속 코드가 맞지 않습니다. 칠판에 표시된 코드를 다시 확인해 주세요.',
  expired: '접속 코드가 만료되었습니다. 칠판에 표시된 새 코드를 입력해 주세요.',
  locked: '코드를 여러 번 잘못 입력했습니다. 1분 뒤 다시 시도해 주세요.',
  version: '수신 프로그램과 버전이 맞지 않습니다. 두 프로그램을 최신 버전으로 업데이트해 주세요.',
  timeout: '선생님 PC에서 승인하지 않아 요청이 취소되었습니다.',
};

async function connect({ code, address, name, audio }) {
  if (conn) return;
  settings.name = name;
  settings.audio = audio;
  saveSettings();
  conn = { state: 'connecting', pcName: '' };

  let target;
  if (address) {
    // 직접 입력한 주소: 처음 연결한 인증서를 기억해 두고 이후 바뀌면 경고한다.
    const [host, p] = address.trim().split(':');
    target = { hosts: [host], port: Number(p) || TLS_PORT, fp: settings.pins[address.trim()] || null, pcName: host, manual: address.trim() };
    setState('connecting', `${host}에 연결하는 중입니다…`);
  } else {
    setState('connecting', '같은 네트워크에서 선생님 PC를 찾는 중입니다…');
    target = await discover(code);
    if (!conn) return;
    if (!target) {
      return end('이 코드를 사용하는 PC를 찾지 못했습니다. 코드를 확인하거나, ‘코드로 연결이 안 될 때’를 눌러 칠판 아래쪽의 PC 주소를 입력해 주세요.');
    }
  }
  conn.pcName = target.pcName;

  let result = { error: 'unreachable' };
  for (const h of target.hosts) {
    result = await tryConnect(h, target.port, target.fp);
    if (result.socket || result.error === 'mismatch') break;
  }
  if (!conn) return result.socket?.destroy();
  if (!result.socket) {
    return end(result.error === 'mismatch'
      ? '선생님 PC를 확인할 수 없습니다(보안 인증 불일치). 주소가 맞는지 선생님께 확인해 주세요.'
      : '선생님 PC에 연결할 수 없습니다. 노트북이 학교 네트워크에 연결되어 있는지 확인해 주세요.');
  }
  if (target.manual && !target.fp) {
    settings.pins[target.manual] = result.fp;
    saveSettings();
  }

  const socket = result.socket;
  socket.setNoDelay(true);
  conn.socket = socket;
  conn.lastRx = Date.now();
  const parser = new FrameParser(onFrame);
  socket.on('data', (d) => {
    if (!conn || conn.socket !== socket) return;
    conn.lastRx = Date.now();
    try {
      parser.push(d);
    } catch {
      socket.destroy();
    }
  });
  socket.on('close', () => {
    if (conn && conn.socket === socket) {
      end(conn.state === 'waiting' ? '선생님 PC가 응답하지 않습니다.' : '선생님 PC와의 연결이 끊겼습니다. 네트워크를 확인한 뒤 다시 연결해 주세요.');
    }
  });
  socket.on('error', () => {});
  socket.write(encode(T.HELLO, {
    proto: PROTO_VERSION,
    code: code || '',
    device: name,
    model: `Windows ${os.release()}`,
    platform: 'windows',
    audio,
    app: app.getVersion(),
  }));
  setState('waiting', '선생님 PC에서 ‘허용’을 기다리는 중입니다.');
  conn.watchdog = setInterval(() => {
    // 승인 대기는 최대 75초, 공유 중에는 PC가 2초마다 신호를 보낸다.
    const limit = conn.state === 'waiting' ? 75000 : 10000;
    if (Date.now() - conn.lastRx > limit) socket.destroy();
  }, 1000);
}

function onFrame(f) {
  if (!conn) return;
  switch (f.type) {
    case T.ACCEPT: {
      const j = parseJson(f.payload) || {};
      conn.mode = j.mode || 'stable';
      setState('consent', '화면을 준비하는 중입니다…');
      send('start-capture', { mode: conn.mode, audio: settings.audio, displayId: settings.displayId });
      break;
    }
    case T.REJECT:
      end(REJECT_TEXT[(parseJson(f.payload) || {}).reason] || '선생님 PC가 연결을 받아들이지 않았습니다.');
      break;
    case T.CONTROL: {
      const c = parseJson(f.payload) || {};
      if (c.t === 'keyframe') send('keyframe');
      else if (c.t === 'mode') send('mode', c.v);
      else if (c.t === 'audio_mute') send('audio-mute', !!c.v);
      else if (c.t === 'bye') end(c.reason === 'timeout' ? '시간 안에 공유가 시작되지 않아 연결이 종료되었습니다.' : '선생님이 화면 공유를 종료했습니다.');
      break;
    }
    case T.PING:
      write(T.PONG);
      break;
    default:
      break;
  }
}

function write(type, payload, opts) {
  const s = conn?.socket;
  if (!s || s.destroyed) return false;
  s.write(encode(type, payload, opts));
  return true;
}

function end(message) {
  const c = conn;
  conn = null;
  if (c) {
    clearInterval(c.watchdog);
    if (c.socket && !c.socket.destroyed) {
      c.socket.end();
      setTimeout(() => c.socket.destroy(), 1000);
    }
  }
  send('stop-capture');
  if (win) win.setContentProtection(false);
  send('state', { state: 'ended', message, pcName: c?.pcName || '' });
  if (win && win.isMinimized()) win.restore();
}

function stopByUser(reason = 'user', message = '화면 공유를 종료했습니다.') {
  if (!conn) return;
  write(T.CONTROL, { t: 'bye', reason });
  end(message);
}

// ---------- 화면에서 오는 요청 ----------

function setupIpc() {
  ipcMain.handle('init', () => ({ settings: { name: settings.name, audio: settings.audio, displayId: settings.displayId }, displays: displayList() }));
  ipcMain.on('connect', (_e, opts) => connect(opts));
  ipcMain.on('stop', () => stopByUser());
  ipcMain.on('set-display', (_e, id) => {
    settings.displayId = id;
    saveSettings();
  });
  ipcMain.on('open-notifications', () => shell.openExternal('ms-settings:notifications'));
  ipcMain.on('minimize', () => win && win.minimize());

  // 캡처가 시작되면 전송 단계로 넘어간다.
  ipcMain.on('capture-started', (_e, info) => {
    if (!conn || conn.state !== 'consent') return;
    setState('streaming', '선생님 PC로 화면을 보내는 중입니다.', { audio: info.audio });
    write(T.CONTROL, { t: 'audio', v: info.audio });
  });
  ipcMain.on('capture-failed', (_e, msg) => stopByUser('consent_denied', msg || '화면을 캡처할 수 없습니다.'));
  ipcMain.on('video-config', (_e, c) => write(T.VIDEO_CONFIG, c));
  ipcMain.on('audio-config', (_e, c) => write(T.AUDIO_CONFIG, c));
  ipcMain.on('audio', (_e, buf, pts) => {
    if (conn?.state !== 'streaming') return;
    if ((conn.socket?.writableLength || 0) > 4_000_000) return; // 심하게 밀리면 소리도 버린다
    write(T.AUDIO, Buffer.from(buf), { pts: BigInt(Math.round(pts)) });
  });
  // 영상: 전송이 밀려 있으면 화면 쪽에 알려 키프레임까지 건너뛰게 한다.
  ipcMain.handle('video', (_e, buf, key, pts) => {
    if (conn?.state !== 'streaming') return { ok: false };
    const backlog = conn.socket?.writableLength || 0;
    if (!key && backlog > (conn.mode === 'quality' ? 600_000 : 350_000)) return { ok: false, congested: true };
    write(T.VIDEO, Buffer.from(buf), { flags: key ? FLAG_KEY : 0, pts: BigInt(Math.round(pts)) });
    return { ok: true, backlog };
  });
}

function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `${i + 1}번 화면 ${d.size.width}×${d.size.height}${d.id === primary ? ' (주 모니터)' : ''}`,
  }));
}

// 화면에서 getDisplayMedia를 부르면, 고른 모니터와 시스템 소리를 바로 넘겨준다(선택 창 없음).
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const want = String(settings.displayId ?? screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.display_id === want) || sources[0];
      if (!src) return callback({});
      const res = { video: src };
      if (request.audioRequested && settings.audio) res.audio = 'loopbackWithMute';
      callback(res);
    } catch {
      callback({});
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#f8fafc',
    title: '화면 보내기',
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
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', () => stopByUser());
  win.on('closed', () => (win = null));
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  loadSettings();
  setupIpc();
  setupDisplayMedia();
  createWindow();
  // 개발용 자동 시험(설치본에서는 동작하지 않음): SMIRROR_SENDER_CODE=123456
  if (!app.isPackaged && process.env.SMIRROR_SENDER_CODE) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(() => connect({ code: process.env.SMIRROR_SENDER_CODE, address: process.env.SMIRROR_SENDER_ADDR || null, name: '시험 노트북', audio: true }), 500));
    if (process.env.SMIRROR_SENDER_SHOT) {
      setTimeout(async () => fs.writeFileSync(process.env.SMIRROR_SENDER_SHOT, (await win.webContents.capturePage()).toPNG()), 4000);
    }
    if (process.env.SMIRROR_SENDER_SECONDS) {
      setTimeout(() => stopByUser(), Number(process.env.SMIRROR_SENDER_SECONDS) * 1000);
    }
  }
});

app.on('window-all-closed', () => app.quit());
