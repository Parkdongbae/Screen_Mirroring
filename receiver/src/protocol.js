'use strict';
// 송수신 프로토콜 v1 (docs/protocol.md)

const PROTO_VERSION = 1;
const HEADER_SIZE = 14;
const MAX_PAYLOAD = 8 * 1024 * 1024;

const T = {
  HELLO: 1,
  ACCEPT: 2,
  REJECT: 3,
  VIDEO_CONFIG: 10,
  VIDEO: 11,
  AUDIO_CONFIG: 20,
  AUDIO: 21,
  CONTROL: 30,
  PING: 31,
  PONG: 32,
};

const FLAG_KEY = 1;

function encode(type, payload, { flags = 0, pts = 0n } = {}) {
  let body;
  if (payload == null) body = Buffer.alloc(0);
  else if (Buffer.isBuffer(payload)) body = payload;
  else body = Buffer.from(JSON.stringify(payload), 'utf8');
  const h = Buffer.alloc(HEADER_SIZE);
  h.writeUInt8(type, 0);
  h.writeUInt8(flags, 1);
  h.writeBigInt64BE(BigInt(pts), 2);
  h.writeUInt32BE(body.length, 10);
  return Buffer.concat([h, body]);
}

// 스트림에서 프레임을 잘라 낸다.
class FrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.chunks = [];
    this.size = 0;
  }

  push(data) {
    this.chunks.push(data);
    this.size += data.length;
    while (this.size >= HEADER_SIZE) {
      const head = this._peek(HEADER_SIZE);
      const len = head.readUInt32BE(10);
      if (len > MAX_PAYLOAD) throw new Error('payload too large');
      if (this.size < HEADER_SIZE + len) break;
      const all = this._take(HEADER_SIZE + len);
      this.onFrame({
        type: all.readUInt8(0),
        flags: all.readUInt8(1),
        pts: all.readBigInt64BE(2),
        payload: all.subarray(HEADER_SIZE),
      });
    }
  }

  _peek(n) {
    if (this.chunks[0].length < n) {
      this.chunks = [Buffer.concat(this.chunks)];
    }
    return this.chunks[0].subarray(0, n);
  }

  _take(n) {
    const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = buf.subarray(0, n);
    const rest = buf.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    return out;
  }
}

function parseJson(payload) {
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { PROTO_VERSION, HEADER_SIZE, T, FLAG_KEY, encode, FrameParser, parseJson };
