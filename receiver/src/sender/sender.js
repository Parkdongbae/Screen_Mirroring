'use strict';
// 화면·소리를 캡처해 H.264(WebCodecs)와 PCM으로 바꿔 메인 프로세스로 넘긴다.

const $ = (id) => document.getElementById(id);
const api = window.sender;

// ---------- 화면 상태 ----------

function render(s) {
  const busy = s.state === 'connecting' || s.state === 'waiting' || s.state === 'consent';
  const active = busy || s.state === 'streaming';
  $('spinner').classList.toggle('hidden', !busy);
  $('status-text').textContent = s.message || '';
  $('status').classList.toggle('error', s.state === 'ended' && !/종료했습니다|종료되었습니다/.test(s.message || ''));
  $('form').classList.toggle('hidden', active);
  $('active').classList.toggle('hidden', !active);
  $('live').classList.toggle('hidden', s.state !== 'streaming');
  $('btn-minimize').classList.toggle('hidden', s.state !== 'streaming');
  $('hidden-note').classList.toggle('hidden', s.state !== 'streaming');
  $('btn-stop').textContent = s.state === 'streaming' ? '공유 종료' : '취소';
  if (s.state === 'streaming') {
    lastStreamingState = s;
    updateLiveDetail();
  }
  if (s.state === 'ended') $('btn-connect').disabled = false;
}

let lastStreamingState = null;
let audioWanted = false;
let audioMuted = false; // 교사 PC에서 소리를 끈 상태
let audioTrack = null;

function updateLiveDetail() {
  const s = lastStreamingState;
  if (!s) return;
  let audio;
  if (!audioWanted) audio = '화면만 보내는 중';
  else if (s.audio === 'unsupported') audio = '소리는 보낼 수 없어 화면만 보냅니다';
  else if (audioMuted) audio = '선생님 PC에서 소리를 꺼 두었습니다(노트북에서 소리가 납니다)';
  else audio = '소리도 함께 보내는 중(노트북 스피커는 꺼짐)';
  $('live-detail').textContent = `${s.pcName || '교실 PC'} · ${audio}`;
}

// ---------- 영상 ----------

let stream = null;
let encoder = null;
let encCfg = null; // {codec, width, height, bitrate}
let mode = 'stable';
let bitrate = 0;
let minBitrate = 0;
let maxBitrate = 0;
let wantKey = true;
let dropUntilKey = false;
let lastCongestion = 0;
let lastEncodeAt = 0;
let lastFrame = null;
let refreshTimer = null;
let adaptTimer = null;
let codecChoice = null;
let running = false;
const t0 = performance.now();

function applyMode(m) {
  mode = m === 'quality' || m === 'grid' ? m : 'stable';
  if (mode === 'grid') {
    // 교실 PC가 여러 화면으로 나눠 보여 줄 때: 작은 칸에 맞춰 해상도와 비트레이트를 낮춘다.
    minBitrate = 300_000;
    maxBitrate = 1_500_000;
    bitrate = 1_000_000;
  } else if (mode === 'quality') {
    minBitrate = 1_500_000;
    maxBitrate = 8_000_000;
    bitrate = 5_000_000;
  } else {
    minBitrate = 600_000;
    maxBitrate = 4_000_000;
    bitrate = 2_500_000;
  }
}

const longCap = () => (mode === 'quality' ? 1920 : mode === 'grid' ? 960 : 1280);

async function pickCodec(width, height) {
  const candidates = ['avc1.640033', 'avc1.4d0033', 'avc1.420033', 'avc1.64002a', 'avc1.42002a'];
  for (const accel of ['prefer-hardware', 'no-preference']) {
    for (const codec of candidates) {
      const cfg = { codec, width, height, bitrate, framerate: 30, latencyMode: 'realtime', hardwareAcceleration: accel, avc: { format: 'annexb' } };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r.supported) return { codec, accel };
      } catch {}
    }
  }
  return null;
}

async function configure(width, height) {
  if (!codecChoice) codecChoice = await pickCodec(width, height);
  if (!codecChoice) throw new Error('이 노트북에서 영상 압축(H.264)을 사용할 수 없습니다.');
  if (!encoder) {
    encoder = new VideoEncoder({ output: onChunk, error: (e) => console.warn('encoder', e) });
  }
  encoder.configure({
    codec: codecChoice.codec,
    width,
    height,
    bitrate,
    bitrateMode: 'variable',
    framerate: 30,
    latencyMode: 'realtime',
    hardwareAcceleration: codecChoice.accel,
    avc: { format: 'annexb' },
  });
  const sizeChanged = !encCfg || encCfg.width !== width || encCfg.height !== height;
  encCfg = { width, height, bitrate };
  if (sizeChanged) api.videoConfig({ w: width, h: height });
  wantKey = true;
}

async function onChunk(chunk) {
  const buf = new Uint8Array(chunk.byteLength);
  chunk.copyTo(buf);
  const key = chunk.type === 'key';
  if (!key && dropUntilKey) return;
  const r = await api.video(buf, key, chunk.timestamp);
  if (key && r.ok) dropUntilKey = false;
  if (r.congested) {
    // 전송이 밀리면 키프레임까지 건너뛰고 비트레이트를 낮춘다.
    dropUntilKey = true;
    wantKey = true;
    const now = performance.now();
    if (now - lastCongestion > 1000) {
      lastCongestion = now;
      bitrate = Math.max(minBitrate, Math.round(bitrate * 0.7));
    }
  }
}

function evenFloor(v) {
  return Math.max(2, v & ~1);
}

async function encodeFrame(frame, ts) {
  const w = evenFloor(frame.displayWidth);
  const h = evenFloor(frame.displayHeight);
  if (!encCfg || encCfg.width !== w || encCfg.height !== h || encCfg.bitrate !== bitrate) {
    await configure(w, h);
  }
  if (encoder.encodeQueueSize > 2) return; // 인코더가 밀리면 이 프레임은 건너뛴다
  const f = ts === undefined ? frame : new VideoFrame(frame, { timestamp: ts });
  encoder.encode(f, { keyFrame: wantKey });
  if (f !== frame) f.close();
  wantKey = false;
  lastEncodeAt = performance.now();
}

async function videoLoop(track) {
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  while (running) {
    const { value: frame, done } = await reader.read();
    if (done || !frame) break;
    try {
      if (lastFrame) lastFrame.close();
      lastFrame = frame.clone();
      await encodeFrame(frame, Math.round((performance.now() - t0) * 1000));
    } catch (e) {
      console.warn(e);
      if (!encCfg) {
        frame.close();
        api.captureFailed(e.message);
        return;
      }
    }
    frame.close();
  }
  if (running) api.captureFailed('화면 캡처가 중단되었습니다.');
}

// 화면이 멈춰 있으면 캡처 프레임이 오지 않으므로 마지막 화면을 1초마다 다시 보낸다.
function refreshTick() {
  if (!running || !lastFrame) return;
  const idle = performance.now() - lastEncodeAt;
  if (idle > 1000 || (wantKey && idle > 150)) {
    const ts = Math.round((performance.now() - t0) * 1000);
    encodeFrame(lastFrame, ts).catch(() => {});
  }
}

// 6초 동안 막힘이 없으면 비트레이트를 조금 올린다.
function adaptTick() {
  if (!running) return;
  if (performance.now() - lastCongestion > 6000 && bitrate < maxBitrate) {
    bitrate = Math.min(maxBitrate, Math.round(bitrate * 1.15));
  }
}

// ---------- 소리 ----------

async function audioLoop(track) {
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  let sentConfig = false;
  while (running) {
    const { value: data, done } = await reader.read();
    if (done || !data) break;
    try {
      const n = data.numberOfFrames;
      const chans = Math.min(2, data.numberOfChannels);
      if (!sentConfig) {
        api.audioConfig({ rate: data.sampleRate, channels: 2, format: 's16le' });
        sentConfig = true;
      }
      const planes = [];
      for (let c = 0; c < chans; c++) {
        const p = new Float32Array(n);
        data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
        planes.push(p);
      }
      const out = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        const l = planes[0][i];
        const r = chans > 1 ? planes[1][i] : l;
        out[i * 2] = Math.max(-1, Math.min(1, l)) * 32767;
        out[i * 2 + 1] = Math.max(-1, Math.min(1, r)) * 32767;
      }
      api.audio(new Uint8Array(out.buffer), data.timestamp);
    } catch (e) {
      console.warn('audio', e);
    }
    data.close();
  }
}

// ---------- 시작·종료 ----------

async function startCapture({ mode: m, audio }) {
  applyMode(m);
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: !!audio });
  } catch (e) {
    api.captureFailed('화면 캡처를 시작할 수 없습니다.');
    return;
  }
  const vtrack = stream.getVideoTracks()[0];
  try {
    await vtrack.applyConstraints({ width: { max: longCap() }, height: { max: longCap() }, frameRate: { max: 30 } });
  } catch {}
  vtrack.addEventListener('ended', () => running && api.stop());
  running = true;
  audioWanted = !!audio;
  audioMuted = false;
  const atrack = stream.getAudioTracks()[0];
  const audioState = !audio ? 'off' : atrack ? 'on' : 'unsupported';
  api.captureStarted({ audio: audioState });
  videoLoop(vtrack);
  if (atrack) {
    audioTrack = atrack;
    audioLoop(atrack);
  }
  refreshTimer = setInterval(refreshTick, 100);
  adaptTimer = setInterval(adaptTick, 3000);
}

function stopCapture() {
  running = false;
  clearInterval(refreshTimer);
  clearInterval(adaptTimer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (audioTrack) audioTrack.stop();
  audioTrack = null;
  lastStreamingState = null;
  if (encoder) {
    try { encoder.close(); } catch {}
  }
  encoder = null;
  encCfg = null;
  codecChoice = null;
  dropUntilKey = false;
  if (lastFrame) lastFrame.close();
  lastFrame = null;
}

api.onStartCapture(startCapture);
api.onStopCapture(stopCapture);
api.onKeyframe(() => {
  wantKey = true;
});
// 교사 PC에서 소리를 끄면 소리 캡처를 멈춰 노트북 스피커가 다시 나오게 하고,
// 다시 켜면 시스템 소리만 새로 받아 온다(화면은 그대로 유지).
api.onAudioMute(async (muted) => {
  audioMuted = muted;
  updateLiveDetail();
  if (!running || !audioWanted) return;
  if (muted) {
    if (audioTrack) audioTrack.stop();
    audioTrack = null;
    return;
  }
  if (audioTrack && audioTrack.readyState === 'live') return;
  try {
    const s2 = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    s2.getVideoTracks().forEach((t) => t.stop());
    const t = s2.getAudioTracks()[0];
    if (!t || audioMuted || !running) {
      t?.stop();
      return;
    }
    audioTrack = t;
    audioLoop(t);
  } catch (e) {
    console.warn('audio restart', e);
  }
});

api.onMode(async (m) => {
  if (!running || !stream) return;
  applyMode(m);
  try {
    await stream.getVideoTracks()[0].applyConstraints({ width: { max: longCap() }, height: { max: longCap() }, frameRate: { max: 30 } });
  } catch {}
});

// ---------- 입력 ----------

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('code').value.trim();
  const address = $('address').value.trim();
  if (!/^\d{6}$/.test(code)) {
    render({ state: 'ended', message: '칠판에 표시된 6자리 숫자 코드를 입력해 주세요.' });
    $('code').focus();
    return;
  }
  $('btn-connect').disabled = true;
  api.connect({ code, address: address || null, name: $('name').value.trim() || '학생 노트북', audio: $('audio').checked });
});
$('code').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});
$('btn-stop').addEventListener('click', () => api.stop());
$('btn-minimize').addEventListener('click', () => api.minimize());
$('btn-notify').addEventListener('click', () => api.openNotifications());
$('display').addEventListener('change', (e) => api.setDisplay(Number(e.target.value)));

api.onState(render);

(async () => {
  const init = await api.init();
  $('name').value = init.settings.name || '';
  $('audio').checked = init.settings.audio !== false;
  if (init.displays.length > 1) {
    $('display-row').classList.remove('hidden');
    for (const d of init.displays) {
      const o = document.createElement('option');
      o.value = String(d.id);
      o.textContent = d.label;
      o.selected = d.id === init.settings.displayId;
      $('display').appendChild(o);
    }
  }
  $('code').focus();
})();
