'use strict';

const $ = (id) => document.getElementById(id);
const api = window.mirror;

let settings = {};
let current = { sessions: [] };

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
const tiles = new Map(); // id -> tile
let focusId = null;

function render(s) {
  current = s;
  const shown = s.sessions.filter((x) => x.state === 'waiting' || x.state === 'streaming');
  const requests = s.sessions.filter((x) => x.state === 'request');
  $('idle').classList.toggle('hidden', shown.length > 0);
  $('stage').classList.toggle('hidden', shown.length === 0);

  // 대기 화면
  $('pc-name').textContent = s.pcName || '교실 PC';
  if (s.code) {
    $('code').textContent = s.code;
    if (s.qr) {
      $('qr').src = s.qr;
      $('join-qr').src = s.qr;
    }
  }
  const address = s.ips && s.ips.length ? `PC 주소 ${s.ips.join(', ')}${s.port !== 47600 ? ` · 포트 ${s.port}` : ''}` : '네트워크에 연결되어 있지 않습니다.';
  $('address').textContent = address;
  $('join-address').textContent = address;
  clearInterval(expiryTimer);
  if (s.expiresAt) {
    const tick = () => {
      const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000));
      $('expires').textContent = `${Math.floor(left / 60)}분 ${String(left % 60).padStart(2, '0')}초 후 새 코드로 바뀝니다`;
    };
    tick();
    expiryTimer = setInterval(tick, 1000);
  }

  // 공유 중 참여 코드
  $('join-code').textContent = s.full ? '가득 참' : s.code || '------';
  $('join-code-big').textContent = s.code || '';
  $('join-count').textContent = `${s.sessions.filter((x) => x.state !== 'request').length}/${s.max || 6}대`;

  renderRequests(requests);
  renderTiles(shown);
}

function renderRequests(requests) {
  $('requests').classList.toggle('hidden', requests.length === 0);
  $('btn-approve-all').classList.toggle('hidden', requests.length < 2);
  const list = $('request-list');
  list.innerHTML = '';
  for (const r of requests) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.device;
    const no = document.createElement('button');
    no.className = 'ghost';
    no.textContent = '거절';
    no.onclick = () => api.reject(r.id);
    const yes = document.createElement('button');
    yes.className = 'primary';
    yes.textContent = '허용';
    yes.onclick = () => api.approve(r.id);
    li.append(name, no, yes);
    list.appendChild(li);
  }
}

// 대수에 따라 1×1, 2×1, 2×2, 3×2로 나눈다.
function layoutFor(n) {
  if (n <= 1) return [1, 1];
  if (n === 2) return [2, 1];
  if (n <= 4) return [2, 2];
  return [3, 2];
}

function renderTiles(shown) {
  const grid = $('grid');
  const ids = new Set(shown.map((x) => x.id));
  for (const [id, t] of tiles) if (!ids.has(id)) removeTile(id, t);
  for (const sess of shown) {
    let t = tiles.get(sess.id);
    if (!t) t = createTile(sess.id);
    t.el.classList.toggle('waiting', sess.state !== 'streaming');
    t.el.querySelector('.tile-name').textContent = sess.device;
    const mute = t.el.querySelector('.tile-mute');
    mute.textContent = sess.muted ? '소리 꺼짐' : '소리 켜짐';
    mute.classList.toggle('muted-on', sess.muted);
    t.muted = sess.muted;
    const badge = t.el.querySelector('.tile-badge');
    const note = sess.audio === 'unsupported' ? '소리 미지원' : sess.audio === 'denied' ? '소리 권한 꺼짐' : null;
    badge.textContent = note || '';
    badge.classList.toggle('hidden', !note);
    grid.appendChild(t.el); // 연결 순서대로 배치
  }
  if (focusId !== null && !tiles.has(focusId)) focusId = null;
  const [cols, rows] = layoutFor(shown.length);
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--rows', rows);
  grid.classList.toggle('multi', shown.length > 1);
  grid.classList.toggle('focused', focusId !== null);
  for (const [id, t] of tiles) {
    t.el.classList.toggle('focus', id === focusId);
    t.el.querySelector('.tile-focus').textContent = id === focusId ? '나눠 보기' : '크게';
    t.el.querySelector('.tile-focus').classList.toggle('hidden', shown.length < 2);
  }
  if (shown.length) showUi();
}

function createTile(id) {
  // 템플릿 문서가 아니라 현재 문서의 노드로 만들어야 캔버스를 그릴 수 있다.
  const el = document.importNode($('tile-tpl').content.firstElementChild, true);
  const canvas = el.querySelector('canvas');
  const t = {
    id,
    el,
    canvas,
    ctx: null, // 화면에 붙은 뒤 처음 그릴 때 얻는다
    decoder: null,
    codec: null,
    waitKey: true,
    pending: null,
    lastKeyRequest: 0,
    muted: false,
    audio: null,
  };
  el.querySelector('.tile-mute').onclick = () => api.mute(id, !t.muted);
  el.querySelector('.tile-stop').onclick = () => api.stop(id);
  el.querySelector('.tile-focus').onclick = () => {
    focusId = focusId === id ? null : id;
    renderTiles(current.sessions.filter((x) => x.state === 'waiting' || x.state === 'streaming'));
  };
  el.addEventListener('dblclick', () => el.querySelector('.tile-focus').click());
  tiles.set(id, t);
  return t;
}

function removeTile(id, t) {
  resetVideo(t);
  if (t.audio) {
    try { t.audio.node.disconnect(); } catch {}
  }
  t.el.remove();
  tiles.delete(id);
}

// ---------- 영상 ----------

function requestKeyframe(t) {
  const now = performance.now();
  if (now - t.lastKeyRequest < 500) return;
  t.lastKeyRequest = now;
  api.keyframe(t.id);
}

function resetVideo(t) {
  if (t.decoder) {
    try { t.decoder.close(); } catch {}
  }
  t.decoder = null;
  t.codec = null;
  t.waitKey = true;
  if (t.pending) {
    t.pending.close();
    t.pending = null;
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

// 개발 확인용 통계(개발 실행에서만 콘솔에 찍힌다)
const dbg = { recv: 0, decoded: 0, drawn: 0, errors: 0 };
setInterval(() => {
  if (dbg.recv || dbg.errors) console.debug(`[render] recv=${dbg.recv} decoded=${dbg.decoded} drawn=${dbg.drawn} errors=${dbg.errors} tiles=${[...tiles.values()].map((t) => `${t.id}:${t.codec || '-'}:${t.canvas.width}x${t.canvas.height}`).join(',')}`);
  Object.assign(dbg, { recv: 0, decoded: 0, drawn: 0, errors: 0 });
}, 2000);

function drawLoop() {
  for (const t of tiles.values()) {
    const f = t.pending;
    if (!f) continue;
    t.pending = null;
    try {
      if (t.canvas.width !== f.displayWidth || t.canvas.height !== f.displayHeight) {
        t.canvas.width = f.displayWidth;
        t.canvas.height = f.displayHeight;
      }
      t.ctx ??= t.canvas.getContext('2d', { alpha: false });
      if (t.ctx) {
        t.ctx.drawImage(f, 0, 0, t.canvas.width, t.canvas.height);
        dbg.drawn++;
      }
    } catch (e) {
      // 한 화면의 오류가 다른 화면 그리기를 멈추지 않게 한다.
      dbg.errors++;
      console.warn('draw error', t.id, e);
    } finally {
      f.close();
    }
  }
  requestAnimationFrame(drawLoop);
}
requestAnimationFrame(drawLoop);

function makeDecoder(t, codec) {
  const d = new VideoDecoder({
    output: (frame) => {
      dbg.decoded++;
      if (t.pending) t.pending.close(); // 가장 최근 프레임만 그린다
      t.pending = frame;
    },
    error: (e) => {
      dbg.errors++;
      console.warn('decoder error', t.id, e);
      resetVideo(t);
      requestKeyframe(t);
    },
  });
  d.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
  return d;
}

api.onVideoConfig(({ id }) => {
  const t = tiles.get(id);
  if (t) t.waitKey = true; // 해상도·회전이 바뀌면 다음 키프레임부터
});

api.onVideo(({ id, data, key, pts }) => {
  dbg.recv++;
  const t = tiles.get(id);
  if (!t) return;
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (t.waitKey && !key) return requestKeyframe(t);
  if (key) {
    const codec = codecFromAnnexB(u8);
    if (codec && codec !== t.codec) {
      resetVideo(t);
      try {
        t.decoder = makeDecoder(t, codec);
        t.codec = codec;
      } catch {
        toast('이 PC에서 영상을 재생할 수 없습니다(코덱 미지원).', 'error');
        return;
      }
    }
    t.waitKey = false;
  }
  if (!t.decoder) {
    t.waitKey = true;
    return requestKeyframe(t);
  }
  if (t.decoder.decodeQueueSize > 8 && !key) {
    t.waitKey = true;
    return requestKeyframe(t);
  }
  try {
    t.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: u8 }));
  } catch {
    resetVideo(t);
    requestKeyframe(t);
  }
});

// ---------- 소리: AudioContext 하나에 기기별 재생 노드를 섞는다 ----------
let audioCtx = null;
let master = null;
let audioReady = null;

function ensureAudioContext() {
  if (audioReady) return audioReady;
  audioReady = (async () => {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('audio-worklet.js');
    master = ctx.createGain();
    master.connect(ctx.destination);
    audioCtx = ctx;
    applyVolume();
    await applySink();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  })();
  return audioReady;
}

async function setupTileAudio(t, cfg) {
  await ensureAudioContext();
  if (t.audio) {
    try { t.audio.node.disconnect(); } catch {}
  }
  const node = new AudioWorkletNode(audioCtx, 'pcm-player', {
    numberOfInputs: 0,
    outputChannelCount: [2],
    processorOptions: { channels: cfg.channels },
  });
  node.connect(master);
  t.audio = { node, cfg, ratio: cfg.rate / audioCtx.sampleRate, carry: 0 };
}

function applyVolume() {
  if (master) master.gain.value = Number(settings.volume ?? 1);
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

api.onAudioConfig(({ id, rate, channels }) => {
  const t = tiles.get(id);
  if (!t) return;
  t.audioSetup = setupTileAudio(t, { rate, channels }).catch((e) => {
    console.warn(e);
    toast('소리를 재생할 수 없습니다.', 'error');
  });
});

// 송신기의 표본율이 48kHz가 아니면 간단히 선형 보간으로 맞춘다.
function toFloat(t, u8) {
  const samples = new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
  const ch = t.audio.cfg.channels;
  const ratio = t.audio.ratio;
  if (Math.abs(ratio - 1) < 1e-6) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
    return out;
  }
  const frames = samples.length / ch;
  const outFrames = Math.max(0, Math.ceil((frames - t.audio.carry) / ratio));
  const out = new Float32Array(Math.max(0, outFrames) * ch);
  for (let o = 0; o < outFrames; o++) {
    const pos = t.audio.carry + o * ratio;
    const i0 = Math.min(frames - 1, Math.floor(pos));
    const i1 = Math.min(frames - 1, i0 + 1);
    const w = pos - i0;
    for (let c = 0; c < ch; c++) out[o * ch + c] = ((1 - w) * samples[i0 * ch + c] + w * samples[i1 * ch + c]) / 32768;
  }
  t.audio.carry = Math.max(0, t.audio.carry + outFrames * ratio - frames);
  return out;
}

api.onAudio(async ({ id, data }) => {
  const t = tiles.get(id);
  if (!t || t.muted) return;
  if (!t.audio) {
    if (t.audioSetup) await t.audioSetup;
    if (!t.audio) return;
  }
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const f32 = toFloat(t, u8);
  if (f32.length) t.audio.node.port.postMessage(f32, [f32.buffer]);
});

// ---------- 도구 모음 ----------
let uiTimer = null;
function showUi() {
  $('stage').classList.add('show-ui');
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    if (!document.querySelector('.tile-bar:hover, .toolbar:hover')) $('stage').classList.remove('show-ui');
  }, 3500);
}
$('stage').addEventListener('pointermove', showUi);
$('stage').addEventListener('pointerdown', showUi);

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
$('btn-approve-all').addEventListener('click', () => api.approveAll());
$('btn-stop-all').addEventListener('click', () => api.stopAll());
$('btn-mute-all').addEventListener('click', () => api.muteAll());
$('btn-new-code').addEventListener('click', () => api.newCode());
$('btn-fullscreen').addEventListener('click', () => api.fullscreen());
$('btn-fullscreen-idle').addEventListener('click', () => api.fullscreen());
$('btn-join').addEventListener('click', () => $('join').classList.remove('hidden'));
$('btn-join-close').addEventListener('click', () => $('join').classList.add('hidden'));
$('volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  api.saveSettings({ volume: settings.volume });
  applyVolume();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'F11') api.fullscreen();
  if (e.key === 'Escape') {
    if (!$('settings').classList.contains('hidden')) $('settings').classList.add('hidden');
    else if (!$('join').classList.contains('hidden')) $('join').classList.add('hidden');
    else if (focusId !== null) {
      focusId = null;
      renderTiles(current.sessions.filter((x) => x.state === 'waiting' || x.state === 'streaming'));
    } else api.fullscreen(false);
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
