'use strict';
// node --test test/  : 내장 접속 서버의 코드·승인·거절 규칙을 시험한다.
const test = require('node:test');
const assert = require('node:assert');
const tls = require('tls');
const crypto = require('crypto');
const selfsigned = require('selfsigned');
const { ReceiverServer } = require('../src/server');
const { T, encode, FrameParser, parseJson, PROTO_VERSION } = require('../src/protocol');

let certP;
async function makeServer() {
  certP ??= selfsigned.generate([{ name: 'commonName', value: 't' }], { keySize: 2048 });
  const pems = await certP;
  const fp = new crypto.X509Certificate(pems.cert).fingerprint256.replace(/:/g, '').toLowerCase();
  const s = new ReceiverServer({ cert: pems.cert, key: pems.private, fingerprint: fp, pcName: 'test', port: 0, discoveryPort: 0 });
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
    resolve({ sock, frames, next: (type, ms = 3000) => waitFor(frames, type, ms) });
  });
}

async function waitFor(frames, type, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const i = frames.findIndex((f) => f.type === type);
    if (i >= 0) return frames.splice(i, 1)[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for type ${type}`);
}

test('잘못된 코드는 badcode, 5회 틀리면 locked', async () => {
  const s = await makeServer();
  try {
    for (let i = 0; i < 5; i++) {
      const c = await client(s.port, { code: '000000' === s.code ? '111111' : '000000' });
      assert.equal(parseJson((await c.next(T.REJECT)).payload).reason, 'badcode');
      c.sock.destroy();
    }
    const c = await client(s.port, { code: s.code });
    assert.equal(parseJson((await c.next(T.REJECT)).payload).reason, 'locked');
    c.sock.destroy();
  } finally {
    s.stop();
  }
});

test('승인 → ACCEPT, 영상 수신, 공유 중 두 번째 요청은 busy, 코드는 재사용 불가', async () => {
  const s = await makeServer();
  const events = [];
  s.on('state', (st) => events.push(st.state));
  s.on('notice', () => events.push('notice'));
  try {
    const code = s.code;
    const a = await client(s.port, { code });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.session.state, 'request');
    s.approve();
    const acc = await a.next(T.ACCEPT);
    assert.equal(parseJson(acc.payload).mode, 'stable');
    assert.equal(s.code, null);

    const videos = [];
    s.on('video', (v) => videos.push(v));
    a.sock.write(encode(T.VIDEO_CONFIG, { w: 1280, h: 720 }));
    a.sock.write(encode(T.VIDEO, Buffer.from([0, 0, 0, 1, 0x65]), { flags: 1, pts: 1000n }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.session.state, 'streaming');
    assert.equal(videos.length, 1);
    assert.equal(videos[0].key, true);

    const b = await client(s.port, { code });
    assert.equal(parseJson((await b.next(T.REJECT)).payload).reason, 'busy');
    b.sock.destroy();

    const ended = new Promise((r) => s.once('ended', r));
    a.sock.write(encode(T.CONTROL, { t: 'bye', reason: 'user' }));
    const e = await ended;
    assert.match(e.text, /휴대전화에서 화면 공유를 종료/);
    assert.notEqual(s.code, code, '종료 후에는 새 코드가 발급된다');

    const c = await client(s.port, { code });
    assert.equal(parseJson((await c.next(T.REJECT)).payload).reason, 'badcode');
    c.sock.destroy();
  } finally {
    s.stop();
  }
});

test('거절하면 REJECT rejected', async () => {
  const s = await makeServer();
  try {
    const a = await client(s.port, { code: s.code });
    await new Promise((r) => setTimeout(r, 200));
    s.reject();
    assert.equal(parseJson((await a.next(T.REJECT)).payload).reason, 'rejected');
  } finally {
    s.stop();
  }
});

test('프로토콜 버전이 다르면 version', async () => {
  const s = await makeServer();
  try {
    const a = await client(s.port, { code: s.code, proto: 99 });
    assert.equal(parseJson((await a.next(T.REJECT)).payload).reason, 'version');
  } finally {
    s.stop();
  }
});
