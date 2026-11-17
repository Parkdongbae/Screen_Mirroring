// 수신한 PCM을 짧은 버퍼로 재생한다. 버퍼가 쌓이면 오래된 소리를 버려 지연을 줄인다.
class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.channels = o.channels || 2;
    this.startFrames = Math.round(sampleRate * 0.06); // 60ms 쌓이면 재생 시작
    this.maxFrames = Math.round(sampleRate * 0.25); // 250ms를 넘으면
    this.trimTo = Math.round(sampleRate * 0.08); // 80ms로 줄인다
    this.queue = [];
    this.offset = 0; // queue[0]에서 읽은 프레임 수
    this.frames = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      if (e.data === 'reset') {
        this.queue = [];
        this.offset = 0;
        this.frames = 0;
        this.playing = false;
        return;
      }
      const chunk = e.data; // Float32Array, 인터리브
      this.queue.push(chunk);
      this.frames += chunk.length / this.channels;
      if (this.frames > this.maxFrames) this._drop(this.frames - this.trimTo);
    };
  }

  _drop(n) {
    while (n > 0 && this.queue.length) {
      const avail = this.queue[0].length / this.channels - this.offset;
      if (avail <= n) {
        this.queue.shift();
        this.offset = 0;
        this.frames -= avail;
        n -= avail;
      } else {
        this.offset += n;
        this.frames -= n;
        n = 0;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const len = out[0].length;
    if (!this.playing) {
      if (this.frames >= this.startFrames) this.playing = true;
      else return true;
    }
    const ch = this.channels;
    for (let i = 0; i < len; i++) {
      if (!this.queue.length) {
        this.playing = false; // 끊기면 다시 쌓일 때까지 기다린다
        break;
      }
      const buf = this.queue[0];
      const base = this.offset * ch;
      for (let c = 0; c < out.length; c++) out[c][i] = buf[base + Math.min(c, ch - 1)];
      this.offset += 1;
      this.frames -= 1;
      if (this.offset * ch >= buf.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
