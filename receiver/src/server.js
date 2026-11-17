'use strict';
// 내장 접속 서버: TLS 수신, UDP 탐색, 접속 코드, 여러 기기(최대 6대)의 세션을 관리한다.
// Electron에 의존하지 않으므로 Node만으로 시험할 수 있다.

const tls = require('tls');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PROTO_VERSION, T, FLAG_KEY, encode, FrameParser, parseJson } = require('./protocol');

const DEFAULT_TLS_PORT = 47600;
const DISCOVERY_PORT = 47601;
const MAX_SESSIONS = 6;
const CODE_TTL_MS = 5 * 60 * 1000;
const APPROVAL_TIMEOUT_MS = 60 * 1000;
const CONSENT_TIMEOUT_MS = 90 * 1000;
const HELLO_TIMEOUT_MS = 10 * 1000;
const PING_INTERVAL_MS = 2000;
const IDLE_TIMEOUT_MS = 10 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
// 3대 이상 동시에 보이면 화면 하나가 작아지므로 송신기에 낮은 해상도를 요청한다.
const GRID_MODE_FROM = 3;

function localIPv4() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Bluetooth/i.test(name);
      out.push({ address: a.address, virtual });
    }
  }
  out.sort((a, b) => a.virtual - b.virtual);
  return out.map((a) => a.address);
}

class ReceiverServer extends EventEmitter {
  /**
   * @param {{cert:string,key:string,fingerprint:string,pcName:string,port?:number,discoveryPort?:number,mode?:string,maxSessions?:number}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.port = 0;
    this.code = null;
    this.codeExpiresAt = 0;
    this.fails = new Map(); // ip -> {count, lockedUntil}
    this.sessions = new Map(); // id -> session
    this.nextId = 1;
    this.mode = opts.mode || 'stable';
    this.maxSessions = opts.maxSessions || MAX_SESSIONS;
    this._codeTimer = null;
  }

  async start() {
    this.tlsServer = tls.createServer(
      { cert: this.opts.cert, key: this.opts.key, minVersion: 'TLSv1.2' },
      (socket) => this._onConnection(socket),
    );
    this.tlsServer.on('tlsClientError', () => {});
    this.port = await this._listen(this.opts.port ?? DEFAULT_TLS_PORT);
    this._startDiscovery();
    this.newCode();
    return this.port;
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && port !== 0) {
          this.tlsServer.removeListener('error', onError);
          resolve(this._listen(0));
        } else reject(err);
      };
      this.tlsServer.once('error', onError);
      this.tlsServer.listen(port, '0.0.0.0', () => {
        this.tlsServer.removeListener('error', onError);
        resolve(this.tlsServer.address().port);
      });
    });
  }

  _startDiscovery() {
    const port = this.opts.discoveryPort ?? DISCOVERY_PORT;
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp.on('error', (err) => this.emit('notice', { level: 'warn', text: `탐색 기능을 시작하지 못했습니다(${err.code}). QR 코드나 PC 주소로 연결해 주세요.` }));
    this.udp.on('message', (msg, rinfo) => {
      let req;
      try {
        req = JSON.parse(msg.toString('utf8'));
      } catch {
        return;
      }
      if (!req || req.t !== 'disc' || typeof req.code !== 'string') return;
      if (this.isFull() || !this.code || req.code !== this.code || Date.now() > this.codeExpiresAt) return;
      const reply = Buffer.from(JSON.stringify({ t: 'here', code: this.code, name: this.opts.pcName, port: this.port, fp: this.opts.fingerprint }));
      this.udp.send(reply, rinfo.port, rinfo.address);
    });
    this.udp.bind(port);
  }

  stop() {
    clearTimeout(this._codeTimer);
    for (const id of [...this.sessions.keys()]) this.endSession(id, 'user');
    this.tlsServer?.close();
    try { this.udp?.close(); } catch {}
  }

  isFull() {
    return this.sessions.size >= this.maxSessions;
  }

  streamingCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.state === 'streaming') n++;
    return n;
  }

  // ---- 접속 코드: 빈자리가 있는 동안 계속 쓰이고 5분마다 바뀐다 ----

  newCode() {
    this.code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.codeExpiresAt = Date.now() + CODE_TTL_MS;
    clearTimeout(this._codeTimer);
    this._codeTimer = setTimeout(() => this.newCode(), CODE_TTL_MS);
    this._emitState();
  }

  connectInfo() {
    const ips = localIPv4();
    const q = new URLSearchParams({ h: ips.join(','), p: String(this.port), c: this.code, f: this.opts.fingerprint, n: this.opts.pcName });
    return { ips, port: this.port, code: this.code, expiresAt: this.codeExpiresAt, uri: `smirror://connect?${q}` };
  }

  sessionList() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      state: s.state,
      device: s.device,
      platform: s.info.platform,
      muted: s.muted,
      audio: s.audioStatus,
    }));
  }

  _emitState(extra = {}) {
    this.emit('state', {
      sessions: this.sessionList(),
      max: this.maxSessions,
      full: this.isFull(),
      pcName: this.opts.pcName,
      ...this.connectInfo(),
      ...extra,
    });
  }

  _checkLock(ip) {
    const f = this.fails.get(ip);
    return f && f.lockedUntil > Date.now();
  }

  _recordFail(ip) {
    const f = this.fails.get(ip) || { count: 0, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) {
      f.lockedUntil = Date.now() + LOCK_MS;
      f.count = 0;
    }
    this.fails.set(ip, f);
  }

  // ---- 연결 처리 ----

  _onConnection(socket) {
    const ip = socket.remoteAddress?.replace('::ffff:', '') || '?';
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    const conn = { socket, ip, session: null, hello: false };
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);

    const parser = new FrameParser((f) => {
      if (!conn.hello) {
        clearTimeout(helloTimer);
        conn.hello = true;
        conn.session = this._onHello(conn, f);
        return;
      }
      if (conn.session && this.sessions.get(conn.session.id) === conn.session) this._onSessionFrame(conn.session, f);
    });

    socket.on('data', (d) => {
      if (conn.session) conn.session.lastRx = Date.now();
      try {
        parser.push(d);
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (conn.session) this._onSessionClosed(conn.session);
    });
  }

  _reject(socket, reason) {
    socket.end(encode(T.REJECT, { reason }));
    setTimeout(() => socket.destroy(), 1000);
  }

  _onHello(conn, f) {
    const { socket, ip } = conn;
    const hello = f.type === T.HELLO ? parseJson(f.payload) : null;
    if (!hello) {
      socket.destroy();
      return null;
    }
    const platform = hello.platform === 'windows' ? 'windows' : 'android';
    const kind = platform === 'windows' ? '노트북' : '휴대전화';
    const device = `${String(hello.device || hello.model || '알 수 없는 기기').slice(0, 60)} (${kind})`;

    if (hello.proto !== PROTO_VERSION) return this._reject(socket, 'version'), null;
    if (this.isFull()) {
      this.emit('notice', { level: 'info', text: `‘${device}’ 기기가 연결을 요청했지만 이미 ${this.maxSessions}대가 연결되어 있어 거절했습니다.` });
      return this._reject(socket, 'busy'), null;
    }
    if (this._checkLock(ip)) return this._reject(socket, 'locked'), null;
    if (typeof hello.code !== 'string' || !this.code || hello.code !== this.code) {
      this._recordFail(ip);
      return this._reject(socket, 'badcode'), null;
    }
    if (Date.now() > this.codeExpiresAt) return this._reject(socket, 'expired'), null;

    this.fails.delete(ip);
    const s = {
      id: this.nextId++,
      socket,
      ip,
      device,
      info: { model: hello.model, platform, android: hello.android, audio: hello.audio, app: hello.app },
      state: 'request',
      muted: false,
      mutedBy: null, // 'auto' | 'teacher'
      audioStatus: null,
      mode: null,
      lastRx: Date.now(),
      timer: null,
      pingTimer: null,
    };
    s.timer = setTimeout(() => this.reject(s.id, 'timeout'), APPROVAL_TIMEOUT_MS);
    this.sessions.set(s.id, s);
    this._emitState();
    return s;
  }

  approve(id) {
    const s = this.sessions.get(id);
    if (!s || s.state !== 'request') return;
    clearTimeout(s.timer);
    s.state = 'waiting';
    s.mode = this._effectiveMode(this.streamingCount() + 1);
    s.socket.write(encode(T.ACCEPT, { mode: s.mode }));
    s.timer = setTimeout(() => this.endSession(s.id, 'timeout'), CONSENT_TIMEOUT_MS);
    s.pingTimer = setInterval(() => this._ping(s), PING_INTERVAL_MS);
    this._emitState();
  }

  approveAll() {
    for (const s of [...this.sessions.values()]) if (s.state === 'request') this.approve(s.id);
  }

  reject(id, reason = 'rejected') {
    const s = this.sessions.get(id);
    if (!s || s.state !== 'request') return;
    clearTimeout(s.timer);
    this.sessions.delete(id);
    this._reject(s.socket, reason);
    if (reason === 'timeout') this.emit('notice', { level: 'info', text: `‘${s.device}’의 승인 대기 시간이 지나 요청을 취소했습니다.` });
    this._emitState();
  }

  _ping(s) {
    if (!this.sessions.has(s.id)) return;
    if (Date.now() - s.lastRx > IDLE_TIMEOUT_MS) {
      s.lostConnection = true;
      s.socket.destroy();
      return;
    }
    s.socket.write(encode(T.PING, null, { pts: BigInt(Date.now()) * 1000n }));
  }

  _send(s, type, payload) {
    if (s && !s.socket.destroyed) s.socket.write(encode(type, payload));
  }

  // ---- 화질: 3대 이상이면 분할 화면용 낮은 화질 ----

  _effectiveMode(count) {
    return count >= GRID_MODE_FROM ? 'grid' : this.mode;
  }

  _applyModes() {
    const m = this._effectiveMode(this.streamingCount());
    for (const s of this.sessions.values()) {
      if (s.state === 'streaming' && s.mode !== m) {
        s.mode = m;
        this._send(s, T.CONTROL, { t: 'mode', v: m });
      }
    }
  }

  setMode(mode) {
    this.mode = mode;
    this._applyModes();
  }

  requestKeyframe(id) {
    const s = this.sessions.get(id);
    if (s && s.state === 'streaming') this._send(s, T.CONTROL, { t: 'keyframe' });
  }

  // ---- 소리: 여러 대가 보이면 기본으로 모두 끈다 ----

  setMuted(id, muted, by = 'teacher') {
    const s = this.sessions.get(id);
    if (!s) return;
    s.muted = muted;
    s.mutedBy = muted ? by : null;
    if (by === 'teacher') s.teacherUnmuted = !muted; // 교사가 직접 켠 소리는 자동으로 끄지 않는다
    // 송신기에 알려 소리 전송을 멈추게 한다(대역폭 절약, 노트북 스피커 복원).
    this._send(s, T.CONTROL, { t: 'audio_mute', v: muted });
    this._emitState();
  }

  muteAll() {
    for (const s of this.sessions.values()) if (!s.muted) this.setMuted(s.id, true, 'teacher');
  }

  _applyAudioPolicy() {
    const live = [...this.sessions.values()].filter((s) => s.state === 'streaming');
    if (live.length >= 2) {
      for (const s of live) if (!s.muted && !s.teacherUnmuted) this.setMuted(s.id, true, 'auto');
    } else if (live.length === 1) {
      const s = live[0];
      if (s.muted && s.mutedBy === 'auto') this.setMuted(s.id, false, 'auto');
    }
  }

  _onSessionFrame(s, f) {
    switch (f.type) {
      case T.VIDEO_CONFIG: {
        const cfg = parseJson(f.payload);
        if (!cfg) return;
        if (s.state === 'waiting') {
          clearTimeout(s.timer);
          s.state = 'streaming';
          this._applyModes();
          this._applyAudioPolicy();
          if (s.muted) this._send(s, T.CONTROL, { t: 'audio_mute', v: true });
          this._emitState();
        }
        this.emit('video-config', { id: s.id, ...cfg });
        break;
      }
      case T.VIDEO:
        if (s.state === 'streaming') this.emit('video', { id: s.id, data: f.payload, key: (f.flags & FLAG_KEY) !== 0, pts: f.pts });
        break;
      case T.AUDIO_CONFIG: {
        const cfg = parseJson(f.payload);
        if (cfg) this.emit('audio-config', { id: s.id, ...cfg });
        break;
      }
      case T.AUDIO:
        if (s.state === 'streaming' && !s.muted) this.emit('audio', { id: s.id, data: f.payload });
        break;
      case T.CONTROL: {
        const c = parseJson(f.payload);
        if (!c) return;
        if (c.t === 'bye') {
          s.byeReason = c.reason || 'user';
          s.socket.end();
        } else if (c.t === 'audio') {
          s.audioStatus = c.v;
          this._emitState();
        }
        break;
      }
      case T.PING:
        this._send(s, T.PONG, null);
        break;
      default:
        break;
    }
  }

  // 교사가 PC에서 종료하거나 시간 초과로 끝낸다.
  endSession(id, reason = 'user') {
    const s = this.sessions.get(id);
    if (!s) return;
    s.endedByPc = reason;
    if (!s.socket.destroyed) {
      s.socket.write(encode(T.CONTROL, { t: 'bye', reason }));
      s.socket.end();
      setTimeout(() => s.socket.destroy(), 1000);
    }
    this._onSessionClosed(s);
  }

  endAll() {
    for (const id of [...this.sessions.keys()]) this.endSession(id, 'user');
  }

  _onSessionClosed(s) {
    if (this.sessions.get(s.id) !== s) return;
    clearTimeout(s.timer);
    clearInterval(s.pingTimer);
    this.sessions.delete(s.id);
    let text;
    if (s.endedByPc === 'timeout') text = `‘${s.device}’에서 화면 공유가 시작되지 않아 연결을 종료했습니다.`;
    else if (s.endedByPc) text = `‘${s.device}’의 화면 공유를 종료했습니다.`;
    else if (s.byeReason === 'consent_denied') text = `‘${s.device}’에서 화면 공유를 시작하지 못했습니다.`;
    else if (s.byeReason) text = `${s.device}에서 화면 공유를 종료했습니다.`;
    else if (s.state === 'request') text = `‘${s.device}’가 연결 요청을 취소했습니다.`;
    else text = `‘${s.device}’와의 연결이 끊겼습니다. 네트워크 상태를 확인해 주세요.`;
    this.emit('ended', { id: s.id, text, device: s.device });
    this._applyModes();
    this._applyAudioPolicy();
    this._emitState();
  }
}

module.exports = { ReceiverServer, localIPv4, DEFAULT_TLS_PORT, DISCOVERY_PORT, MAX_SESSIONS };
