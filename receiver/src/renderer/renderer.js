'use strict';

const $ = (id) => document.getElementById(id);
const api = window.mirror;

let settings = {};
let current = { state: 'idle' };

// ---------- 알림 ----------
function toast(text, level = 'info', ms = 6000) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- 화면 전환 ----------
let expiryTimer = null;

function render(s) {
  const prev = current.state;
  current = s;
  const state = s.state;
  $('idle').classList.toggle('hidden', !(state === 'idle' || state === 'request'));
  $('waiting').classList.toggle('hidden', state !== 'waiting');
  $('stream').classList.toggle('hidden', state !== 'streaming');
  $('request').classList.toggle('hidden', state !== 'request');

  $('pc-name').textContent = s.pcName || '교실 PC';
  if (s.code) {
    $('code').textContent = s.code;
    if (s.qr) $('qr').src = s.qr;
  }
  $('address').textContent = s.ips && s.ips.length ? `PC 주소 ${s.ips.join(', ')} · 포트 ${s.port}` : '네트워크에 연결되어 있지 않습니다.';
  clearInterval(expiryTimer);
  if (state === 'idle' && s.expiresAt) {
    const tick = () => {
      const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
      $('expires').textContent = `${Math.floor(left / 60)}분 ${String(left % 60).padStart(2, '0')}초 후 새 코드로 바뀝니다`;
    };
    tick();
    expiryTimer = setInterval(tick, 1000);
  }
  if (state === 'request') {
    $('request-device').textContent = s.device || '휴대전화';
    $('btn-approve').focus();
  }
  if (state === 'streaming') {
    $('stream-device').textContent = s.device || '';
    showUi();
  }
  if (prev === 'streaming' && state !== 'streaming') {
    resetVideo();
    resetAudio();
    $('stream-audio').classList.add('hidden');
  }
}

// ---------- 영상 ----------
const canvas = $('video');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
let decoder = null;
let configuredCodec = null;
let waitKey = true;
let pendingFrame = null;
let lastKeyRequest = 0;

function requestKeyframe() {
  const now = performance.now();
  if (now - lastKeyRequest < 500) return;
  lastKeyRequest = now;
  api.keyframe();
}

function resetVideo() {
  if (decoder) {
    try { decoder.close(); } catch {}
  }
  decoder = null;
  configuredCodec = null;
  waitKey = true;
  if (pendingFrame) {
    pendingFrame.close();
    pendingFrame = null;
  }
}

// Annex-B에서 SPS를 찾아 avc1 코덱 문자열을 만든다.
function codecFromAnnexB(u8) {
  for (let i = 0; i + 4 < u8.length; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && (u8[i + 2] === 1 || (u8[i + 2] === 0 && u8[i + 3] === 1))) {
      const start = u8[i + 2] === 1 ? i + 3 : i + 4;
      if ((u8[start] & 0x1f) === 7 && start + 3 < u8.length) {
        const hex = (b) => b.toString(16).padStart(2, '0');
        return `avc1.${hex(u8[start + 1])}${hex(u8[start + 2])}${hex(u8[start + 3])}`;
      }
    }
  }
  return null;
}

function drawLoop() {
  if (pendingFrame) {
    const f = pendingFrame;
    pendingFrame = null;
    if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) {
      canvas.width = f.displayWidth;
      canvas.height = f.displayHeight;
    }
    ctx.drawImage(f, 0, 0, canvas.width, canvas.height);
    f.close();
  }
  requestAnimationFrame(drawLoop);
}
requestAnimationFrame(drawLoop);

function makeDecoder(codec) {
  const d = new VideoDecoder({
    output: (frame) => {
      if (pendingFrame) pendingFrame.close(); // 가장 최근 프레임만 그린다
      pendingFrame = frame;
    },
    error: (e) => {
      console.warn('decoder error', e);
      resetVideo();
      requestKeyframe();
    },
  });
  d.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
  return d;
}

api.onVideoConfig(() => {
  // 해상도·회전이 바뀌면 다음 키프레임부터 다시 시작한다.
  waitKey = true;
});

api.onVideo(({ data, key, pts }) => {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (waitKey && !key) {
    requestKeyframe();
    return;
  }
  if (key) {
    const codec = codecFromAnnexB(u8);
    if (codec && codec !== configuredCodec) {
      resetVideo();
      try {
        decoder = makeDecoder(codec);
        configuredCodec = codec;
      } catch (e) {
        toast('이 PC에서 영상을 재생할 수 없습니다(코덱 미지원).', 'error');
        return;
      }
    }
    waitKey = false;
  }
  if (!decoder) {
    waitKey = true;
    requestKeyframe();
    return;
  }
  // 디코더가 밀리면 다음 키프레임까지 건너뛴다.
  if (decoder.decodeQueueSize > 8 && !key) {
    waitKey = true;
    requestKeyframe();
    return;
  }
  try {
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: u8 }));
  } catch (e) {
    resetVideo();
    requestKeyframe();
  }
});

// ---------- 소리 ----------
let audioCtx = null;
let gain = null;
let player = null;
let audioCfg = null;
let audioStarting = null;

async function ensureAudio(cfg) {
  if (audioCtx && audioCfg && audioCfg.rate === cfg.rate && audioCfg.channels === cfg.channels) return;
  resetAudio();
  audioCfg = cfg;
  const ctx = new AudioContext({ sampleRate: cfg.rate, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('audio-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm-player', {
    numberOfInputs: 0,
    outputChannelCount: [2],
    processorOptions: { channels: cfg.channels },
  });
  const g = ctx.createGain();
  node.connect(g).connect(ctx.destination);
  audioCtx = ctx;
  gain = g;
  player = node;
  applyVolume();
  await applySink();
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
}

function resetAudio() {
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = null;
  gain = null;
  player = null;
  audioCfg = null;
  audioStarting = null;
}

function applyVolume() {
  const vol = settings.muted ? 0 : Number(settings.volume ?? 1);
  if (gain) gain.gain.value = vol;
  $('btn-mute').textContent = settings.muted ? '소리 끔' : '소리 켬';
  $('volume').value = String(settings.volume ?? 1);
}

async function applySink() {
  if (!audioCtx || typeof audioCtx.setSinkId !== 'function') return;
  const id = !settings.audioDeviceId || settings.audioDeviceId === 'default' ? '' : settings.audioDeviceId;
  try {
    await audioCtx.setSinkId(id);
  } catch {
    toast('선택한 소리 출력 장치를 사용할 수 없어 기본 장치로 재생합니다.', 'warn');
    try { await audioCtx.setSinkId(''); } catch {}
  }
}

api.onAudioConfig((cfg) => {
  audioStarting = ensureAudio(cfg).catch((e) => {
    console.warn(e);
    toast('소리를 재생할 수 없습니다.', 'error');
  });
});

api.onAudio(async (data) => {
  if (!player) {
    if (audioStarting) await audioStarting;
    if (!player) return;
  }
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const samples = new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
  const f32 = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) f32[i] = samples[i] / 32768;
  player.port.postMessage(f32, [f32.buffer]);
});

api.onAudioStatus((v) => {
  const badge = $('stream-audio');
  if (v === 'unsupported') {
    badge.textContent = '이 휴대전화는 소리 전송을 지원하지 않습니다';
    badge.classList.remove('hidden');
  } else if (v === 'denied') {
    badge.textContent = '휴대전화에서 소리 권한이 꺼져 있습니다';
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
});

// ---------- 공유 화면 도구 모음 ----------
let uiTimer = null;
function showUi() {
  $('stream').classList.add('show-ui');
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    if (!$('toolbar').matches(':hover')) $('stream').classList.remove('show-ui');
  }, 3000);
}
$('stream').addEventListener('pointermove', showUi);
$('stream').addEventListener('pointerdown', showUi);

// ---------- 설정 ----------
async function openSettings() {
  const displays = await api.displays();
  fillDisplays(displays);
  await fillAudioDevices();
  document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === settings.mode));
  $('inp-pcname').value = settings.pcName || '';
  $('settings').classList.remove('hidden');
}

function fillDisplays(displays) {
  const sel = $('sel-display');
  sel.innerHTML = '';
  for (const d of displays) {
    const o = document.createElement('option');
    o.value = String(d.id);
    o.textContent = d.label;
    o.selected = d.current;
    sel.appendChild(o);
  }
}

async function fillAudioDevices() {
  const sel = $('sel-audio');
  sel.innerHTML = '';
  let outs = [];
  try {
    outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  } catch {}
  if (!outs.some((d) => d.deviceId === 'default')) outs.unshift({ deviceId: 'default', label: '' });
  outs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.deviceId === 'default' ? `Windows 기본 장치${d.label ? ` (${d.label.replace(/^Default - |^기본값 - /, '')})` : ''}` : d.label || `출력 장치 ${i}`;
    o.selected = d.deviceId === (settings.audioDeviceId || 'default');
    sel.appendChild(o);
  });
}

$('sel-display').addEventListener('change', (e) => api.setDisplay(Number(e.target.value)));
$('sel-audio').addEventListener('change', (e) => {
  settings.audioDeviceId = e.target.value;
  api.saveSettings({ audioDeviceId: settings.audioDeviceId });
  applySink();
});
document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', () => {
    settings.mode = r.value;
    api.saveSettings({ mode: settings.mode });
  }),
);
$('inp-pcname').addEventListener('change', (e) => {
  settings.pcName = e.target.value.trim() || settings.pcName;
  api.saveSettings({ pcName: settings.pcName });
});
$('btn-settings-close').addEventListener('click', () => $('settings').classList.add('hidden'));
$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-idle').addEventListener('click', openSettings);

// ---------- 버튼 ----------
$('btn-approve').addEventListener('click', () => api.approve());
$('btn-reject').addEventListener('click', () => api.reject());
$('btn-stop').addEventListener('click', () => api.stop());
$('btn-cancel-waiting').addEventListener('click', () => api.stop());
$('btn-new-code').addEventListener('click', () => api.newCode());
$('btn-fullscreen').addEventListener('click', () => api.fullscreen());
$('btn-fullscreen-idle').addEventListener('click', () => api.fullscreen());
$('btn-mute').addEventListener('click', () => {
  settings.muted = !settings.muted;
  api.saveSettings({ muted: settings.muted });
  applyVolume();
});
$('volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  if (settings.muted && settings.volume > 0) settings.muted = false;
  api.saveSettings({ volume: settings.volume, muted: settings.muted });
  applyVolume();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'F11') api.fullscreen();
  if (e.key === 'Escape') {
    if (!$('settings').classList.contains('hidden')) $('settings').classList.add('hidden');
    else api.fullscreen(false);
  }
});

api.onState(render);
api.onNotice((n) => toast(n.text, n.level));
api.onDisplays(fillDisplays);

(async () => {
  const init = await api.init();
  settings = init.settings;
  applyVolume();
  if (init.state) render(init.state);
})();
