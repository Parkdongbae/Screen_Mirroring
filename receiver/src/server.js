'use strict';
// 내장 접속 서버: TLS 수신, UDP 탐색, 접속 코드, 세션 상태를 관리한다.
// Electron에 의존하지 않으므로 Node만으로 시험할 수 있다.

const tls = require('tls');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PROTO_VERSION, T, FLAG_KEY, encode, FrameParser, parseJson } = require('./protocol');

const DEFAULT_TLS_PORT = 47600;
const DISCOVERY_PORT = 47601;
const CODE_TTL_MS = 5 * 60 * 1000;
const APPROVAL_TIMEOUT_MS = 60 * 1000;
const CONSENT_TIMEOUT_MS = 90 * 1000;
const HELLO_TIMEOUT_MS = 10 * 1000;
const PING_INTERVAL_MS = 2000;
const IDLE_TIMEOUT_MS = 10 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

function localIPv4() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      // 가상 어댑터는 뒤로 보낸다.
      const virtual = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Bluetooth/i.test(name);
      out.push({ address: a.address, virtual });
    }
  }
  out.sort((a, b) => a.virtual - b.virtual);
  return out.map((a) => a.address);
}

class ReceiverServer extends EventEmitter {
  /**
   * @param {{cert:string,key:string,fingerprint:string,pcName:string,port?:number,discoveryPort?:number}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.port = 0;
    this.code = null;
    this.codeExpiresAt = 0;
    this.fails = new Map(); // ip -> {count, lockedUntil}
    this.session = null; // {socket, state, device, ...}
    this.mode = opts.mode || 'stable';
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
    this.udp.on('error', (err) => this.emit('notice', { level: 'warn', text: `탐색 기능을 시작하지 못했습니다(${err.code}). QR 코드로 연결해 주세요.` }));
    this.udp.on('message', (msg, rinfo) => {
      let req;
      try {
        req = JSON.parse(msg.toString('utf8'));
      } catch {
        return;
      }
      if (!req || req.t !== 'disc' || typeof req.code !== 'string') return;
      if (this.session || !this.code || req.code !== this.code || Date.now() > this.codeExpiresAt) return;
      const reply = Buffer.from(JSON.stringify({ t: 'here', code: this.code, name: this.opts.pcName, port: this.port, fp: this.opts.fingerprint }));
      this.udp.send(reply, rinfo.port, rinfo.address);
    });
    this.udp.bind(port);
  }

  stop() {
    clearTimeout(this._codeTimer);
    this.endSession('user');
    this.tlsServer?.close();
    try { this.udp?.close(); } catch {}
  }

  // ---- 접속 코드 ----

  newCode() {
    this.code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.codeExpiresAt = Date.now() + CODE_TTL_MS;
    clearTimeout(this._codeTimer);
    this._codeTimer = setTimeout(() => {
      if (!this.session) this.newCode();
    }, CODE_TTL_MS);
    this._emitState();
  }

  connectInfo() {
    const ips = localIPv4();
    const q = new URLSearchParams({ h: ips.join(','), p: String(this.port), c: this.code, f: this.opts.fingerprint, n: this.opts.pcName });
    return { ips, port: this.port, code: this.code, expiresAt: this.codeExpiresAt, uri: `smirror://connect?${q}` };
  }

  _emitState(extra = {}) {
    const s = this.session;
    this.emit('state', {
      state: s ? s.state : 'idle',
      device: s?.device || null,
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
    const conn = { socket, ip, hello: false };
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);

    const parser = new FrameParser((f) => {
      if (!conn.hello) {
        clearTimeout(helloTimer);
        conn.hello = true;
        this._onHello(conn, f);
        return;
      }
      if (this.session && this.session.socket === socket) this._onSessionFrame(f);
    });

    socket.on('data', (d) => {
      if (this.session && this.session.socket === socket) this.session.lastRx = Date.now();
      try {
        parser.push(d);
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (this.session && this.session.socket === socket) this._onSessionClosed();
    });
  }

  _reject(socket, reason) {
    socket.end(encode(T.REJECT, { reason }));
    setTimeout(() => socket.destroy(), 1000);
  }

  _onHello(conn, f) {
    const { socket, ip } = conn;
    const hello = f.type === T.HELLO ? parseJson(f.payload) : null;
    if (!hello) return socket.destroy();
    const device = String(hello.device || hello.model || '알 수 없는 기기').slice(0, 60);

    if (hello.proto !== PROTO_VERSION) return this._reject(socket, 'version');
    if (this.session) {
      this.emit('notice', { level: 'info', text: `‘${device}’ 기기가 연결을 요청했지만 이미 공유 중이라 거절했습니다.` });
      return this._reject(socket, 'busy');
    }
    if (this._checkLock(ip)) return this._reject(socket, 'locked');
    if (typeof hello.code !== 'string' || hello.code !== this.code) {
      this._recordFail(ip);
      return this._reject(socket, 'badcode');
    }
    if (Date.now() > this.codeExpiresAt) return this._reject(socket, 'expired');

    this.fails.delete(ip);
    this.session = {
      socket,
      ip,
      device,
      info: { model: hello.model, android: hello.android, audio: hello.audio, app: hello.app },
      state: 'request',
      lastRx: Date.now(),
      timer: setTimeout(() => this.reject('timeout'), APPROVAL_TIMEOUT_MS),
      pingTimer: null,
    };
    this._emitState();
  }

  approve() {
    const s = this.session;
    if (!s || s.state !== 'request') return;
    clearTimeout(s.timer);
    s.state = 'waiting';
    // 코드는 한 번 승인되면 폐기한다.
    this.code = null;
    s.socket.write(encode(T.ACCEPT, { mode: this.mode }));
    s.timer = setTimeout(() => this.endSession('timeout'), CONSENT_TIMEOUT_MS);
    s.pingTimer = setInterval(() => this._ping(), PING_INTERVAL_MS);
    this._emitState();
  }

  reject(reason = 'rejected') {
    const s = this.session;
    if (!s || s.state !== 'request') return;
    clearTimeout(s.timer);
    this.session = null;
    this._reject(s.socket, reason);
    if (reason === 'timeout') this.emit('notice', { level: 'info', text: '승인 대기 시간이 지나 연결 요청을 취소했습니다.' });
    this._emitState();
  }

  _ping() {
    const s = this.session;
    if (!s) return;
    if (Date.now() - s.lastRx > IDLE_TIMEOUT_MS) {
      this.emit('notice', { level: 'error', text: '휴대전화와의 연결이 끊겼습니다. 네트워크 상태를 확인해 주세요.' });
      s.socket.destroy();
      return;
    }
    s.socket.write(encode(T.PING, null, { pts: BigInt(Date.now()) * 1000n }));
  }

  send(type, payload) {
    const s = this.session;
    if (s && !s.socket.destroyed) s.socket.write(encode(type, payload));
  }

  setMode(mode) {
    this.mode = mode;
    if (this.session && this.session.state === 'streaming') this.send(T.CONTROL, { t: 'mode', v: mode });
  }

  requestKeyframe() {
    if (this.session && this.session.state === 'streaming') this.send(T.CONTROL, { t: 'keyframe' });
  }

  _onSessionFrame(f) {
    const s = this.session;
    switch (f.type) {
      case T.VIDEO_CONFIG: {
        const cfg = parseJson(f.payload);
        if (!cfg) return;
        if (s.state === 'waiting') {
          clearTimeout(s.timer);
          s.state = 'streaming';
          this._emitState();
        }
        this.emit('video-config', cfg);
        break;
      }
      case T.VIDEO:
        if (s.state === 'streaming') this.emit('video', { data: f.payload, key: (f.flags & FLAG_KEY) !== 0, pts: f.pts });
        break;
      case T.AUDIO_CONFIG: {
        const cfg = parseJson(f.payload);
        if (cfg) this.emit('audio-config', cfg);
        break;
      }
      case T.AUDIO:
        if (s.state === 'streaming') this.emit('audio', f.payload);
        break;
      case T.CONTROL: {
        const c = parseJson(f.payload);
        if (!c) return;
        if (c.t === 'bye') {
          s.byeReason = c.reason || 'user';
          s.socket.end();
        } else if (c.t === 'audio') {
          this.emit('audio-status', c.v);
        }
        break;
      }
      case T.PING:
        this.send(T.PONG, null);
        break;
      default:
        break;
    }
  }

  // 교사가 PC에서 종료하거나 시간 초과로 끝낸다.
  endSession(reason = 'user') {
    const s = this.session;
    if (!s) return;
    s.endedByPc = reason;
    if (!s.socket.destroyed) {
      s.socket.write(encode(T.CONTROL, { t: 'bye', reason }));
      s.socket.end();
      setTimeout(() => s.socket.destroy(), 1000);
    }
    this._onSessionClosed();
  }

  _onSessionClosed() {
    const s = this.session;
    if (!s) return;
    clearTimeout(s.timer);
    clearInterval(s.pingTimer);
    this.session = null;
    let text;
    if (s.endedByPc === 'timeout') text = '휴대전화에서 화면 공유가 시작되지 않아 연결을 종료했습니다.';
    else if (s.endedByPc) text = '화면 공유를 종료했습니다.';
    else if (s.byeReason === 'consent_denied') text = '휴대전화에서 화면 공유를 허용하지 않았습니다.';
    else if (s.byeReason) text = '휴대전화에서 화면 공유를 종료했습니다.';
    else if (s.state === 'request') text = '휴대전화가 연결 요청을 취소했습니다.';
    else text = '휴대전화와의 연결이 끊겼습니다.';
    this.emit('ended', { text, device: s.device });
    this.newCode();
  }
}

module.exports = { ReceiverServer, localIPv4, DEFAULT_TLS_PORT, DISCOVERY_PORT };
