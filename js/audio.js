// Audio: one shared AudioContext for music + sound effects, beat detection,
// and a built-in synthesized song so the game works without any music file.

export const ctx = new (window.AudioContext || window.webkitAudioContext)();

const musicGain = ctx.createGain();
musicGain.gain.value = 0.85;
musicGain.connect(ctx.destination);

const sfxGain = ctx.createGain();
sfxGain.gain.value = 0.55;
sfxGain.connect(ctx.destination);

export function decode(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

// ---------- music playback ----------
let source = null;

export function playBuffer(buffer, when) {
  stopMusic();
  source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(musicGain);
  source.start(when);
}

export function stopMusic() {
  if (!source) return;
  try { source.stop(); } catch { /* already stopped */ }
  source.disconnect();
  source = null;
}

// ---------- beat detection ----------
// Onset envelope (10 ms frames) -> autocorrelation for a coarse tempo ->
// Fourier magnitude sweep for a precise tempo, whose phase gives the first beat.
export function analyzeBeat(buffer) {
  const sr = buffer.sampleRate;
  const hop = Math.round(sr / 100);
  const fps = sr / hop;
  const c0 = buffer.getChannelData(0);
  const c1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : c0;
  const n = Math.floor(c0.length / hop);

  const env = new Float32Array(n);
  const a = Math.exp(-2 * Math.PI * 200 / sr);
  let lp = 0;
  for (let i = 0, s = 0; i < n; i++) {
    let eLow = 0, eAll = 0;
    for (let j = 0; j < hop; j++, s++) {
      const x = (c0[s] + c1[s]) * 0.5;
      lp = a * lp + (1 - a) * x;
      eLow += lp * lp;
      eAll += x * x;
    }
    env[i] = Math.log(1e-4 + 2 * eLow + eAll);
  }

  const on = new Float32Array(n);
  for (let i = 1; i < n; i++) on[i] = Math.max(0, env[i] - env[i - 1]);

  // remove the local mean so only sharp onsets remain
  const ps = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + on[i];
  const W = 20;
  const onset = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - W), hi = Math.min(n, i + W);
    onset[i] = Math.max(0, on[i] - (ps[hi] - ps[lo]) / (hi - lo));
  }

  // coarse tempo, weighted towards ~115 BPM to avoid half/double errors
  const minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 60);
  let bestLag = minLag, best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += onset[i] * onset[i - lag];
    s /= (n - lag);
    const bpm = 60 * fps / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.8) ** 2);
    if (s * w > best) { best = s * w; bestLag = lag; }
  }

  // fine tempo + phase
  const coarse = 60 * fps / bestLag;
  let bestBpm = coarse, bestMag = -1, bestRe = 0, bestIm = 0;
  for (let bpm = coarse * 0.97; bpm <= coarse * 1.03; bpm += 0.02) {
    const w = 2 * Math.PI * (bpm / 60) / fps;
    const cw = Math.cos(w), sw = Math.sin(w);
    let re = 0, im = 0, c = 1, s = 0;
    for (let i = 0; i < n; i++) {
      const v = onset[i];
      if (v) { re += v * c; im -= v * s; }
      const nc = c * cw - s * sw;
      s = s * cw + c * sw;
      c = nc;
    }
    const mag = re * re + im * im;
    if (mag > bestMag) { bestMag = mag; bestBpm = bpm; bestRe = re; bestIm = im; }
  }
  const w = 2 * Math.PI * (bestBpm / 60) / fps;
  const period = 2 * Math.PI / w;
  let phase = -Math.atan2(bestIm, bestRe) / w;
  phase = ((phase % period) + period) % period;

  // fold into a comfortable 70-145 BPM range; when halving, keep whichever of
  // the two candidate downbeats carries more onset energy
  const comb = (ph, p) => {
    let s = 0;
    for (let t = ph; t < n; t += p) s += onset[Math.round(t)] || 0;
    return s;
  };
  let bpm = bestBpm, p = period;
  while (bpm > 145) {
    bpm /= 2;
    if (comb(phase + p, p * 2) > comb(phase, p * 2)) phase += p;
    p *= 2;
  }
  while (bpm < 70) { bpm *= 2; p /= 2; phase %= p; }

  return { bpm: Math.round(bpm * 100) / 100, offset: phase / fps };
}

// ---------- built-in song ----------
export const BUILTIN_BPM = 110;

export function makeBuiltinBeat(bpm = BUILTIN_BPM, bars = 56) {
  const sr = ctx.sampleRate;
  const beat = 60 / bpm;
  const len = Math.ceil((bars * 4 * beat + 2) * sr);
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);

  const add = (t0, dur, fn, pan = 0) => {
    const s0 = Math.floor(t0 * sr);
    const count = Math.min(len - s0, Math.floor(dur * sr));
    const gl = 1 - Math.max(0, pan), gr = 1 + Math.min(0, pan);
    for (let i = 0; i < count; i++) {
      const v = fn(i / sr);
      L[s0 + i] += v * gl;
      R[s0 + i] += v * gr;
    }
  };
  const kick = (t) => Math.sin(2 * Math.PI * (45 * t + 5 * (1 - Math.exp(-18 * t)))) * Math.exp(-7 * t) * 0.9;
  const snare = (t) => (Math.random() * 2 - 1) * Math.exp(-18 * t) * 0.3 + Math.sin(2 * Math.PI * 185 * t) * Math.exp(-25 * t) * 0.25;
  const hat = () => { let p = 0; return (t) => { const r = Math.random() * 2 - 1; const v = r - p; p = r; return v * Math.exp(-60 * t) * 0.09; }; };
  const tri = (x) => (2 / Math.PI) * Math.asin(Math.sin(x));

  // C - Am - F - G
  const roots = [65.41, 55.0, 87.31, 98.0];
  const chords = [
    [523.25, 659.25, 783.99, 1046.5],
    [440.0, 523.25, 659.25, 880.0],
    [349.23, 440.0, 523.25, 698.46],
    [392.0, 493.88, 587.33, 783.99],
  ];
  const arp = [0, 1, 2, 3, 2, 1, 0, 1];

  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * 4 * beat;
    const ch = bar % 4;
    const intro = bar < 2;
    const fill = bar % 8 === 7;
    for (let b = 0; b < 4; b++) {
      const tb = t0 + b * beat;
      add(tb, 0.5, kick);
      if (!intro && (b === 1 || b === 3)) add(tb, 0.3, snare);
      add(tb + beat / 2, 0.08, hat(), 0.3);
      add(tb, 0.08, hat(), -0.3);
      if (!intro) {
        const f = roots[ch] * (b % 2 ? 2 : 1);
        add(tb, beat * 0.9, (t) => {
          const x = 2 * Math.PI * f * t;
          return (Math.sin(x) + 0.4 * Math.sin(2 * x) + 0.2 * Math.sin(3 * x)) * 0.2 * Math.min(1, t * 200) * Math.exp(-3 * t);
        });
      }
    }
    if (fill) for (let k = 0; k < 4; k++) add(t0 + 3 * beat + k * beat / 4, 0.2, snare);
    if (!intro) {
      for (let k = 0; k < 8; k++) {
        const f = chords[ch][arp[k]];
        add(t0 + k * beat / 2, beat * 0.5, (t) => tri(2 * Math.PI * f * t) * 0.1 * Math.min(1, t * 300) * Math.exp(-6 * t), k % 2 ? 0.35 : -0.35);
      }
    }
  }
  // final chord
  const tEnd = bars * 4 * beat;
  add(tEnd, 1.8, kick);
  for (const f of chords[0]) add(tEnd, 1.9, (t) => tri(2 * Math.PI * f * t) * 0.08 * Math.exp(-1.6 * t));

  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.9 / (peak || 1);
  for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; }
  return buf;
}

// ---------- sound effects ----------
function tone(freq, t0, dur, type = 'sine', vol = 0.3, freqEnd = null) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(sfxGain);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

export function sfxGood() {
  const t = ctx.currentTime;
  tone(1046.5, t, 0.12, 'triangle', 0.35);
  tone(1568, t + 0.06, 0.2, 'triangle', 0.3);
}
export function sfxBad() {
  const t = ctx.currentTime;
  tone(180, t, 0.32, 'sawtooth', 0.22, 85);
  tone(150, t, 0.32, 'square', 0.1, 70);
}
export function sfxMiss() {
  tone(420, ctx.currentTime, 0.25, 'sine', 0.15, 240);
}
export function sfxClick() {
  tone(660, ctx.currentTime, 0.08, 'square', 0.1);
}
export function sfxCombo() {
  const t = ctx.currentTime;
  [784, 988, 1175, 1568].forEach((f, i) => tone(f, t + i * 0.06, 0.14, 'triangle', 0.22));
}
