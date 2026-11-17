'use strict';
// npm test : 내장 접속 서버의 코드·승인·거절·여러 대 연결 규칙을 시험한다.
const test = require('node:test');
const assert = require('node:assert');
const tls = require('tls');
const crypto = require('crypto');
const selfsigned = require('selfsigned');
const { ReceiverServer } = require('../src/server');
const { T, encode, FrameParser, parseJson, PROTO_VERSION } = require('../src/protocol');

let certP;
async function makeServer(extra = {}) {
  certP ??= selfsigned.generate([{ name: 'commonName', value: 't' }], { keySize: 2048 });
  const pems = await certP;
  const fp = new crypto.X509Certificate(pems.cert).fingerprint256.replace(/:/g, '').toLowerCase();
  const s = new ReceiverServer({ cert: pems.cert, key: pems.private, fingerprint: fp, pcName: 'test', port: 0, discoveryPort: 0, ...extra });
  await s.start();
  return s;
}

function client(port, hello) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
      sock.write(encode(T.HELLO, { proto: PROTO_VERSION, device: 'Galaxy', audio: true, ...hello }));
    });
    const parser = new FrameParser((f) => frames.push(f));
    sock.on('data', (d) => parser.push(d));
    sock.on('error', reject);
    resolve({
      sock,
      frames,
      next: (type, ms = 3000) => waitFor(frames, type, ms),
      controls: () => frames.filter((f) => f.type === T.CONTROL).map((f) => parseJson(f.payload)),
    });
  });
}

async function waitFor(frames, type, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const i = frames.findIndex((f) => f.type === type);
    if (i >= 0) return frames.splice(i, 1)[0];
    await sleep(20);
  }
  throw new Error(`timeout waiting for type ${type}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reason = async (c) => parseJson((await c.next(T.REJECT)).payload).reason;
const lastSession = (s) => [...s.sessions.values()].at(-1);

// 승인 후 영상 설정을 보내 공유 중 상태로 만든다.
async function startStreaming(s, c) {
  await sleep(150);
  const sess = lastSession(s);
  s.approve(sess.id);
  const acc = parseJson((await c.next(T.ACCEPT)).payload);
  c.sock.write(encode(T.VIDEO_CONFIG, { w: 1280, h: 720 }));
  await sleep(150);
  return { sess, acc };
}

test('잘못된 코드는 badcode, 5회 틀리면 locked', async () => {
  const s = await makeServer();
  try {
    for (let i = 0; i < 5; i++) {
      const c = await client(s.port, { code: s.code === '000000' ? '111111' : '000000' });
      assert.equal(await reason(c), 'badcode');
      c.sock.destroy();
    }
    const c = await client(s.port, { code: s.code });
    assert.equal(await reason(c), 'locked');
    c.sock.destroy();
  } finally {
    s.stop();
  }
});

test('승인하면 ACCEPT, 영상이 기기 번호와 함께 전달된다', async () => {
  const s = await makeServer();
  try {
    const a = await client(s.port, { code: s.code });
    const videos = [];
    s.on('video', (v) => videos.push(v));
    const { sess, acc } = await startStreaming(s, a);
    assert.equal(acc.mode, 'stable');
    assert.equal(sess.state, 'streaming');
    a.sock.write(encode(T.VIDEO, Buffer.from([0, 0, 0, 1, 0x65]), { flags: 1, pts: 1000n }));
    await sleep(150);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].id, sess.id);
    assert.equal(videos[0].key, true);

    const ended = new Promise((r) => s.once('ended', r));
    a.sock.write(encode(T.CONTROL, { t: 'bye', reason: 'user' }));
    const e = await ended;
    assert.equal(e.text, 'Galaxy (휴대전화)에서 화면 공유를 종료했습니다.');
    assert.equal(s.sessions.size, 0);
  } finally {
    s.stop();
  }
});

test('여러 대가 같은 코드로 접속하고, 6대가 차면 7번째는 busy', async () => {
  const s = await makeServer();
  const clients = [];
  try {
    for (let i = 0; i < 6; i++) {
      const c = await client(s.port, { code: s.code, device: `모둠${i + 1}`, platform: i % 2 ? 'windows' : 'android' });
      clients.push(c);
      await startStreaming(s, c);
    }
    assert.equal(s.streamingCount(), 6);
    assert.equal(s.isFull(), true);
    const extra = await client(s.port, { code: s.code });
    assert.equal(await reason(extra), 'busy');
    extra.sock.destroy();
    const names = s.sessionList().map((x) => x.device);
    assert.ok(names.includes('모둠2 (노트북)') && names.includes('모둠1 (휴대전화)'));
  } finally {
    clients.forEach((c) => c.sock.destroy());
    s.stop();
  }
});

test('2대째가 공유를 시작하면 모두 음소거되고, 1대만 남으면 자동으로 다시 켜진다', async () => {
  const s = await makeServer();
  try {
    const a = await client(s.port, { code: s.code, device: 'A' });
    const { sess: sa } = await startStreaming(s, a);
    assert.equal(sa.muted, false);

    const b = await client(s.port, { code: s.code, device: 'B' });
    const { sess: sb } = await startStreaming(s, b);
    assert.equal(sa.muted, true);
    assert.equal(sb.muted, true);
    assert.ok(a.controls().some((c) => c.t === 'audio_mute' && c.v === true), '송신기에 소리 끄기를 알린다');

    // 교사가 B의 소리를 켜면 켜진 상태를 유지한다.
    s.setMuted(sb.id, false);
    assert.equal(sb.muted, false);

    // 음소거된 기기의 소리는 화면으로 넘기지 않는다.
    const audios = [];
    s.on('audio', (x) => audios.push(x.id));
    a.sock.write(encode(T.AUDIO, Buffer.alloc(16)));
    b.sock.write(encode(T.AUDIO, Buffer.alloc(16)));
    await sleep(150);
    assert.deepEqual(audios, [sb.id]);

    // B가 나가면 자동으로 꺼졌던 A의 소리가 다시 켜진다.
    const ended = new Promise((r) => s.once('ended', r));
    b.sock.destroy();
    await ended;
    assert.equal(sa.muted, false);
    a.sock.destroy();
  } finally {
    s.stop();
  }
});

test('3대 이상 공유하면 분할 화면 화질(grid)을 요청하고, 줄면 원래 화질로 돌린다', async () => {
  const s = await makeServer();
  const cs = [];
  try {
    for (let i = 0; i < 3; i++) {
      const c = await client(s.port, { code: s.code, device: `G${i}` });
      cs.push(c);
      await startStreaming(s, c);
    }
    await sleep(100);
    assert.ok(cs[0].controls().some((c) => c.t === 'mode' && c.v === 'grid'));
    const ended = new Promise((r) => s.once('ended', r));
    cs[2].sock.destroy();
    await ended;
    await sleep(100);
    const modes = cs[0].controls().filter((c) => c.t === 'mode').map((c) => c.v);
    assert.equal(modes.at(-1), 'stable');
  } finally {
    cs.forEach((c) => c.sock.destroy());
    s.stop();
  }
});

test('거절하면 REJECT rejected, 다른 요청은 그대로 남는다', async () => {
  const s = await makeServer();
  try {
    const a = await client(s.port, { code: s.code, device: 'A' });
    const b = await client(s.port, { code: s.code, device: 'B' });
    await sleep(200);
    const [ida] = [...s.sessions.keys()];
    s.reject(ida);
    assert.equal(await reason(a), 'rejected');
    assert.equal(s.sessions.size, 1);
    s.approveAll();
    await b.next(T.ACCEPT);
    b.sock.destroy();
  } finally {
    s.stop();
  }
});

test('프로토콜 버전이 다르면 version', async () => {
  const s = await makeServer();
  try {
    const a = await client(s.port, { code: s.code, proto: 99 });
    assert.equal(await reason(a), 'version');
  } finally {
    s.stop();
  }
});
