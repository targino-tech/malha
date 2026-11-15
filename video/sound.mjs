// Trilha e efeitos do vídeo do Malha, sintetizados por código (sem amostras de terceiros).
//
//   node video/sound.mjs   → video/out/malha-45s.wav e video/out/malha-45s.mp4 (imagem + som)
//
// Música eletrônica a 120 BPM em lá menor (Lá m – Fá – Dó – Sol) e efeitos sincronizados com a
// linha do tempo de src/main.ts. Tudo é determinístico: duas execuções geram o mesmo arquivo.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const SR = 48000;
const DURATION = 45;
const N = SR * DURATION;
const STEP = 0.125; // semicolcheia a 120 BPM
const BAR = 2;
const GRID = 4; // a batida começa no "drop" de 4 s

let seed = 20261115;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const noise = () => random() * 2 - 1;
const mtof = (midi) => 440 * 2 ** ((midi - 69) / 12);
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const range = (t, a, b) => clamp((t - a) / (b - a));
const TAU = Math.PI * 2;

const bus = () => [new Float32Array(N), new Float32Array(N)];
const drums = bus();
const synth = bus();
const fx = bus();
const send = bus();
const kicks = [];

/** Soma um som em `target` a partir de `start`, com ganho, pan (-1 a 1) e envio para o reverb. */
function place(target, start, duration, render, { gain = 1, pan = 0, reverb = 0 } = {}) {
  const i0 = Math.round(start * SR);
  const length = Math.round(duration * SR);
  const left = Math.cos(((pan + 1) * Math.PI) / 4);
  const right = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < length; i += 1) {
    const index = i0 + i;
    if (index < 0) continue;
    if (index >= N) break;
    const value = render(i / SR) * gain;
    target[0][index] += value * left;
    target[1][index] += value * right;
    if (reverb) { send[0][index] += value * left * reverb; send[1][index] += value * right * reverb; }
  }
}

// Filtro de estado variável (topologia TPT): passa-baixa, passa-banda ou passa-alta.
class Filter {
  constructor() { this.a = 0; this.b = 0; }
  run(x, cutoff, q = 0.707, mode = 'low') {
    const g = Math.tan((Math.PI * clamp(cutoff, 20, SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.b;
    const v1 = a1 * this.a + a2 * v3;
    const v2 = this.b + a2 * this.a + a3 * v3;
    this.a = 2 * v1 - this.a;
    this.b = 2 * v2 - this.b;
    return mode === 'low' ? v2 : mode === 'band' ? v1 : x - k * v1 - v2;
  }
}

// Serra com polyBLEP (menos serrilhado nos agudos).
function saw() {
  let phase = random();
  return (freq) => {
    const dt = freq / SR;
    let value = 2 * phase - 1;
    if (phase < dt) { const t = phase / dt; value -= t + t - t * t - 1; } else if (phase > 1 - dt) { const t = (phase - 1) / dt; value -= t * t + t + t + 1; }
    phase += dt;
    if (phase >= 1) phase -= 1;
    return value;
  };
}
function sine() {
  let phase = 0;
  return (freq) => { phase += freq / SR; if (phase >= 1) phase -= 1; return Math.sin(phase * TAU); };
}

// ---------- Bateria ----------
function kick(t0, velocity = 1) {
  kicks.push(t0);
  const osc = sine();
  place(drums, t0, 0.5, (t) => osc(44 + 120 * Math.exp(-t / 0.032)) * Math.exp(-t / 0.26) + (t < 0.003 ? noise() * 0.35 * (1 - t / 0.003) : 0), { gain: 0.95 * velocity });
}
function clap(t0, velocity = 1) {
  const filter = new Filter();
  place(drums, t0, 0.35, (t) => {
    const bursts = (t < 0.03 ? (Math.floor(t / 0.01) % 1 === 0 ? Math.exp(-(t % 0.01) / 0.003) : 0) : 0) + Math.exp(-t / 0.11) * 0.8;
    return filter.run(noise(), 1400, 1.1, 'band') * bursts;
  }, { gain: 0.55 * velocity, pan: 0.05, reverb: 0.25 });
}
function hat(t0, open = false, velocity = 1) {
  const filter = new Filter();
  place(drums, t0, open ? 0.3 : 0.06, (t) => filter.run(noise(), 8000, 0.8, 'high') * Math.exp(-t / (open ? 0.12 : 0.022)), { gain: 0.22 * velocity, pan: 0.25 });
}
function shaker(t0, velocity = 1) {
  const filter = new Filter();
  place(drums, t0, 0.07, (t) => filter.run(noise(), 6000, 1.2, 'band') * Math.sin(Math.PI * clamp(t / 0.06)), { gain: 0.12 * velocity, pan: -0.35 });
}
function crash(t0, gain = 0.4) {
  const filter = new Filter();
  place(drums, t0, 2.4, (t) => filter.run(noise(), 4500, 0.7, 'high') * Math.exp(-t / 0.7), { gain, reverb: 0.4 });
}

// ---------- Sintetizadores ----------
function bass(t0, duration, midi) {
  const a = saw();
  const sub = sine();
  const filter = new Filter();
  const f = mtof(midi);
  place(synth, t0, duration + 0.05, (t) => {
    const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.18) * (t > duration ? Math.exp(-(t - duration) / 0.01) : 1);
    return (filter.run(a(f), 300 + 1600 * Math.exp(-t / 0.06), 1.2) * 0.6 + sub(f) * 0.7) * env;
  }, { gain: 0.42 });
}
function pad(t0, duration, chord, { gain = 0.16, cutoff = () => 1800 } = {}) {
  for (const midi of chord) {
    const voices = [-0.09, 0, 0.11].map(() => saw());
    const filter = new Filter();
    place(synth, t0, duration + 0.8, (t) => {
      const env = Math.min(1, t / 0.35) * (t > duration ? Math.exp(-(t - duration) / 0.3) : 1);
      const f = mtof(midi);
      const value = voices[0](f * 0.995) + voices[1](f) + voices[2](f * 1.006);
      return filter.run(value / 3, cutoff(t0 + t), 0.8) * env;
    }, { gain, pan: (midi % 3 - 1) * 0.35, reverb: 0.5 });
  }
}
function pluck(t0, midi, { gain = 0.13, pan = 0, cutoff = 3200 } = {}) {
  const a = saw();
  const filter = new Filter();
  const f = mtof(midi);
  place(synth, t0, 0.35, (t) => filter.run(a(f), 400 + cutoff * Math.exp(-t / 0.05), 2) * Math.exp(-t / 0.12), { gain, pan, reverb: 0.35 });
}

// ---------- Efeitos ----------
function blip(t0, freq, { gain = 0.22, pan = 0, decay = 0.09, reverb = 0.35, glide = 0 } = {}) {
  const osc = sine();
  const mod = sine();
  place(fx, t0, decay * 6, (t) => osc(freq * (1 + glide * Math.exp(-t / 0.03)) + mod(freq * 2) * freq * 0.6 * Math.exp(-t / 0.02)) * Math.min(1, t / 0.002) * Math.exp(-t / decay), { gain, pan, reverb });
}
function bell(t0, freq, { gain = 0.2, pan = 0, decay = 0.7 } = {}) {
  const carrier = sine();
  const modulator = sine();
  place(fx, t0, decay * 5, (t) => carrier(freq + modulator(freq * 3.5) * freq * 2.2 * Math.exp(-t / 0.25)) * Math.min(1, t / 0.003) * Math.exp(-t / decay), { gain, pan, reverb: 0.6 });
}
function tick(t0, freq = 2400, { gain = 0.08, pan = 0 } = {}) {
  const osc = sine();
  place(fx, t0, 0.04, (t) => osc(freq) * Math.exp(-t / 0.008), { gain, pan });
}
function thunk(t0, { gain = 0.3, pan = 0 } = {}) {
  const osc = sine();
  const filter = new Filter();
  place(fx, t0, 0.3, (t) => osc(70 + 90 * Math.exp(-t / 0.03)) * Math.exp(-t / 0.09) + filter.run(noise(), 2500, 1, 'band') * Math.exp(-t / 0.012) * 0.4, { gain, pan });
}
/** Sopro de ar com filtro varrendo; o pico fica em `peak`. */
function whoosh(peak, length = 0.9, { gain = 0.32, from = 300, to = 5000, pan = [-0.6, 0.6] } = {}) {
  const filter = new Filter();
  const start = peak - length * 0.75;
  const left = Math.cos(((pan[0] + 1) * Math.PI) / 4);
  const leftEnd = Math.cos(((pan[1] + 1) * Math.PI) / 4);
  const i0 = Math.round(start * SR);
  const n = Math.round(length * SR);
  for (let i = 0; i < n; i += 1) {
    const index = i0 + i;
    if (index < 0 || index >= N) continue;
    const k = i / n;
    const rise = k < 0.75 ? (k / 0.75) ** 2.2 : Math.exp(-(k - 0.75) / 0.06);
    const cutoff = from * (to / from) ** Math.min(1, k / 0.75);
    const value = filter.run(noise(), cutoff, 1.6, 'band') * rise * gain;
    const l = left + (leftEnd - left) * k;
    const r = Math.sqrt(Math.max(0, 1 - l * l));
    fx[0][index] += value * l;
    fx[1][index] += value * r;
    send[0][index] += value * l * 0.3;
    send[1][index] += value * r * 0.3;
  }
}
function riser(t0, t1, { gain = 0.22 } = {}) {
  const filter = new Filter();
  const tone = saw();
  const duration = t1 - t0;
  place(fx, t0, duration, (t) => {
    const k = t / duration;
    const trem = 0.6 + 0.4 * Math.sin(TAU * (4 + 20 * k) * t);
    return (filter.run(noise(), 400 + 7000 * k * k, 2, 'band') * 0.8 + tone(180 + 900 * k * k) * 0.15) * k ** 2 * trem;
  }, { gain, reverb: 0.3 });
}
function reverseCymbal(t0, t1, { gain = 0.25 } = {}) {
  const filter = new Filter();
  const duration = t1 - t0;
  place(fx, t0, duration, (t) => filter.run(noise(), 5000, 0.7, 'high') * (t / duration) ** 3, { gain, reverb: 0.2 });
}
function impact(t0, { gain = 0.8, size = 1 } = {}) {
  const sub = sine();
  const filter = new Filter();
  place(fx, t0, 2.5 * size, (t) => sub(32 + 60 * Math.exp(-t / 0.08)) * Math.exp(-t / (0.9 * size)) + filter.run(noise(), 900, 0.7) * Math.exp(-t / 0.09) * 0.7, { gain, reverb: 0.45 });
  crash(t0, 0.3 * size);
}
function zap(t0, from, to, duration = 0.18, { gain = 0.1, pan = 0 } = {}) {
  const osc = sine();
  place(fx, t0, duration, (t) => osc(from * (to / from) ** (t / duration)) * Math.sin(Math.PI * (t / duration)), { gain, pan, reverb: 0.3 });
}
function glitch(t0, duration, { gain = 0.28 } = {}) {
  const filter = new Filter();
  let held = 0;
  let hold = 0;
  let cutoff = 2000;
  place(fx, t0, duration, (t) => {
    if (hold <= 0) { held = noise(); hold = Math.floor(random() * 90) + 4; if (random() < 0.08) cutoff = 400 + random() * 5000; }
    hold -= 1;
    const gate = Math.sin(TAU * 38 * t) > -0.2 ? 1 : 0;
    return filter.run(Math.round(held * 4) / 4, cutoff, 3, 'band') * gate * (1 - t / duration);
  }, { gain, pan: 0.1 });
}
function sweep(t0, duration, from, to, { gain = 0.2 } = {}) {
  const tone = saw();
  const filter = new Filter();
  place(fx, t0, duration, (t) => {
    const k = t / duration;
    const f = from * (to / from) ** k;
    return filter.run(tone(f), f * 4, 1.5) * Math.sin(Math.PI * Math.min(1, k * 1.2));
  }, { gain, reverb: 0.25 });
}
function alarm(t0, count = 3, { gain = 0.16 } = {}) {
  for (let i = 0; i < count * 2; i += 1) {
    const filter = new Filter();
    const tone = saw();
    const f = i % 2 === 0 ? 880 : 659.25;
    place(fx, t0 + i * 0.13, 0.12, (t) => filter.run(tone(f), 2600, 0.9) * Math.min(1, t / 0.004) * (t < 0.1 ? 1 : Math.exp(-(t - 0.1) / 0.008)), { gain, pan: i % 2 ? 0.2 : -0.2, reverb: 0.2 });
  }
}

// ---------- Música ----------
const CHORDS = [
  { pad: [57, 60, 64], root: 33, arp: [69, 72, 76, 81, 84, 88] }, // Lá menor
  { pad: [53, 57, 60], root: 29, arp: [65, 69, 72, 77, 81, 84] }, // Fá
  { pad: [55, 60, 64], root: 36, arp: [67, 72, 76, 79, 84, 88] }, // Dó
  { pad: [55, 59, 62], root: 31, arp: [67, 71, 74, 79, 83, 86] }, // Sol
];
const ARP = [0, 1, 2, 3, 4, 3, 2, 1, 0, 2, 4, 5, 4, 2, 1, 2];

/** Uma faixa completa entre `from` e `to`, alinhada à grade a partir de `grid`. */
function groove(from, to, { grid = GRID, shaker: withShaker = false, openHats = false, lifted = false } = {}) {
  for (let step = Math.ceil((from - grid) / STEP); grid + step * STEP < to - 1e-6; step += 1) {
    const t = grid + step * STEP;
    const s = ((step % 16) + 16) % 16;
    const chord = CHORDS[((Math.floor(step / 16) % 4) + 4) % 4];
    if (s % 4 === 0) kick(t);
    if (s === 4 || s === 12) clap(t);
    if (s % 4 === 2) hat(t, openHats && s === 14, 1);
    else if (s % 2 === 1) hat(t, false, 0.45);
    if (withShaker) shaker(t, s % 2 ? 0.7 : 1);
    if (s % 4 === 2 || s === 15) bass(t, s === 15 ? 0.1 : 0.22, chord.root + (s === 15 ? 12 : 0));
    // Arpejo mais suave e mais claro onde a cena pede energia (sobe uma oitava em parte das notas).
    const lift = lifted && s % 8 >= 6 ? 12 : 0;
    pluck(t, chord.arp[ARP[s]] + lift, { pan: s % 2 ? 0.4 : -0.4, gain: 0.075, cutoff: 2200 });
    if (s === 0) pad(t, BAR, chord.pad);
  }
}

// Abertura: acorde que abre e arpejo filtrado subindo até o drop.
pad(0.4, 3.6, CHORDS[0].pad, { gain: 0.14, cutoff: (t) => 300 + 1800 * range(t, 0.4, 4) });
for (let t = 2; t < 4 - 1e-6; t += STEP) {
  const s = Math.round((t - 2) / STEP) % 16;
  pluck(t, CHORDS[0].arp[ARP[s]], { gain: 0.025 + 0.05 * range(t, 2, 4), cutoff: 300 + 2000 * range(t, 2, 4), pan: s % 2 ? 0.4 : -0.4 });
}
// Primeiro bloco: do drop até a queda da internet.
groove(4, 14.7);
// Queda: só o acorde abafado e um pulso grave, como batimento.
pad(14.7, 3.3, CHORDS[3].pad, { gain: 0.14, cutoff: () => 500 });
for (let t = 15; t < 17.8; t += 0.5) kick(t, 0.35);
// Volta: batida inteira até o pré-final; mais energia no monitoramento e no acesso.
groove(18, 28);
groove(28, 36, { shaker: true, lifted: true });
groove(36, 40.9, { shaker: true, openHats: true, lifted: true });
// Final: resolve em Lá menor com duas batidas e cauda longa.
groove(41.5, 43.5, { grid: 41.5 });
pad(41.5, 2.6, [57, 60, 64, 71], { gain: 0.15, cutoff: () => 2600 });
pad(43.5, 1.5, [45, 57, 64], { gain: 0.12, cutoff: () => 1400 });

// ---------- Efeitos sincronizados com a imagem ----------
const PENTA = [69, 72, 74, 76, 79, 81, 84, 86, 88];
// 1 · Marca
reverseCymbal(0, 0.42, { gain: 0.18 });
impact(0.42, { gain: 0.55, size: 0.8 });
zap(0.45, 300, 1400, 0.9, { gain: 0.05 });
[0, 1, 2].forEach((i) => zap(1.0 + i * 0.16, 900, 2600, 0.16, { gain: 0.06, pan: -0.3 + i * 0.3 }));
[81, 84, 88].forEach((midi, i) => blip(1.45 + i * 0.12, mtof(midi), { gain: 0.2, pan: -0.3 + i * 0.3 }));
blip(1.8, mtof(76), { gain: 0.16, decay: 0.12 });
whoosh(2.05, 0.6, { gain: 0.22, from: 600, to: 7000 });
thunk(2.05, { gain: 0.22 });
blip(2.55, mtof(93), { gain: 0.22, decay: 0.07, glide: 0.4 });
bell(2.65, mtof(81), { gain: 0.08, decay: 0.9 });
riser(2.9, 4.0, { gain: 0.2 });
impact(4.0, { gain: 0.6 });

// 2 · Globo: pings de dados nas rotas, mergulho até Mato Grosso, fazendas.
for (let t = 4.5; t < 9.6; t += 0.25) if (random() < 0.5) blip(t, mtof(PENTA[Math.floor(random() * PENTA.length)] + 12), { gain: 0.07, pan: random() * 1.4 - 0.7, decay: 0.06 });
whoosh(4.45, 0.5, { gain: 0.1, from: 2000, to: 9000 });
whoosh(10.25, 3.4, { gain: 0.3, from: 150, to: 4500, pan: [0.5, -0.4] });
sweep(7.2, 3.1, 200, 1600, { gain: 0.05 });
blip(10.3, mtof(88), { gain: 0.2 });
blip(10.4, mtof(93), { gain: 0.2 });
blip(10.55, mtof(93), { gain: 0.14, pan: 0.3 });
blip(10.7, mtof(76) - 9, { gain: 0.14, pan: -0.4, decay: 0.12 });
blip(10.85, mtof(72), { gain: 0.08, pan: 0.1, decay: 0.05 });
whoosh(9.95, 0.4, { gain: 0.08, from: 2000, to: 9000 });
whoosh(12.35, 0.9);

// 3 · Coleta: conexão, queda, alerta, volta e reenvio da fila.
thunk(12.75, { gain: 0.25, pan: -0.5 });
thunk(12.9, { gain: 0.25, pan: 0.5 });
blip(13.15, mtof(76), { gain: 0.16, pan: -0.3 });
blip(13.27, mtof(81), { gain: 0.16, pan: 0.3 });
for (let packet = 0; packet < 3; packet += 1) {
  for (let k = 0; k < 20; k += 1) {
    const t = (k - packet / 3) / 0.55;
    if (t > 13.25 && t < 14.65) { blip(t, mtof(88), { gain: 0.1, pan: 0.55, decay: 0.04 }); tick(t, 2000, { gain: 0.05, pan: -0.55 }); }
  }
}
glitch(14.7, 0.45);
sweep(14.7, 0.7, 420, 50, { gain: 0.25 });
impact(14.72, { gain: 0.3, size: 0.5 });
for (let k = 1; k <= 24; k += 1) tick(14.9 + (2.7 * k) / 24, 1600 + k * 35, { gain: 0.07, pan: -0.5 });
alarm(16.6, 3);
impact(16.6, { gain: 0.25, size: 0.4 });
riser(17.1, 17.95, { gain: 0.24 });
sweep(17.85, 0.5, 60, 600, { gain: 0.2 });
[81, 84, 88, 93].forEach((midi, i) => blip(17.95 + i * 0.06, mtof(midi), { gain: 0.16, pan: -0.3 + i * 0.2 }));
impact(18, { gain: 0.55 });
for (let i = 0; i < 10; i += 1) blip(18.65 + i * 0.12, mtof(PENTA[Math.min(PENTA.length - 1, i)]), { gain: 0.14, pan: 0.5, decay: 0.05 });
[72, 76, 81].forEach((midi) => bell(18.5, mtof(midi + 12), { gain: 0.07, pan: 0.4 }));
blip(19.5, mtof(84), { gain: 0.08 });
whoosh(20.3, 1.0, { gain: 0.34 });

// 4 · Painel: entrada da tela, destaques e troca para os painéis.
thunk(20.8, { gain: 0.25, pan: 0.4 });
whoosh(20.7, 0.4, { gain: 0.08, from: 2000, to: 9000 });
[[21.5, 81], [22.6, 84], [23.5, 88], [25.3, 81], [26.4, 84]].forEach(([t, midi]) => { blip(t, mtof(midi), { gain: 0.15, glide: 0.25, pan: 0.4 }); tick(t + 0.05, 5200, { gain: 0.05, pan: 0.5 }); });
whoosh(24.3, 0.6, { gain: 0.2, from: 800, to: 8000, pan: [0.6, -0.6] });
whoosh(28.45, 0.9);

// 5 · Monitoramento: famílias, conexões, hosts, painéis e aplicação pela API.
whoosh(28.9, 0.4, { gain: 0.08, from: 2000, to: 9000 });
[69, 72, 74, 76].forEach((midi, i) => pluck(29.3 + i * 0.22, midi, { gain: 0.16, pan: -0.5, cutoff: 4000 }));
thunk(29.5, { gain: 0.2, pan: 0.5 });
thunk(29.7, { gain: 0.2, pan: 0.5 });
for (let i = 0; i < 4; i += 1) zap(30.3 + i * 0.12, 500, 2600, 0.5, { gain: 0.06, pan: 0.2 });
for (let t = 31.25; t < 35.8; t += STEP) if (random() < 0.3) blip(t, 1800 + random() * 1600, { gain: 0.035, pan: random() * 1.2 - 0.2, decay: 0.025, reverb: 0.1 });
for (let value = 1; value <= 6; value += 1) blip(31 + 2 * (1 - (1 - (value - 0.5) / 6) ** (1 / 3)), mtof(76 + value * 2), { gain: 0.1, pan: 0.5, decay: 0.04 });
[79, 81, 84, 86].forEach((midi, i) => blip(31.2 + i * 0.25, mtof(midi), { gain: 0.1, pan: 0.6, decay: 0.06 }));
[64, 67, 69, 72].forEach((midi, i) => pluck(31.6 + i * 0.2, midi + 12, { gain: 0.08, pan: 0.6 }));
bell(33.6, mtof(88), { gain: 0.14, pan: 0.5 });
bell(33.72, mtof(93), { gain: 0.14, pan: 0.5 });
whoosh(36.65, 0.9);

// 6 · Acesso e segurança.
whoosh(36.95, 0.4, { gain: 0.08, from: 2000, to: 9000 });
[0, 1, 2].forEach((i) => { thunk(37.35 + i * 0.18, { gain: 0.2, pan: -0.5 + i * 0.5 }); tick(37.36 + i * 0.18, 3000 + i * 400, { gain: 0.06, pan: -0.5 + i * 0.5 }); });
whoosh(39.15, 0.4, { gain: 0.1, from: 2000, to: 9000 });
[84, 88, 93].forEach((midi, i) => bell(39.45 + i * 0.22, mtof(midi), { gain: 0.11, pan: -0.5 + i * 0.5, decay: 0.5 }));
riser(40.0, 41.45, { gain: 0.26 });
reverseCymbal(40.6, 41.48, { gain: 0.28 });

// 7 · Final.
impact(41.5, { gain: 0.85, size: 1.3 });
whoosh(42.05, 0.6, { gain: 0.15, from: 600, to: 8000 });
[81, 84, 86, 88, 91].forEach((midi, i) => blip(42.45 + i * 0.1, mtof(midi), { gain: 0.1, pan: -0.6 + i * 0.3, decay: 0.07 }));
bell(42.95, mtof(93), { gain: 0.08, decay: 1.2 });

// ---------- Mixagem ----------
// Reverb (Freeverb): 8 filtros pente e 4 passa-tudo por canal.
function reverb(input, spread) {
  const scale = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => ({ buf: new Float32Array(Math.round((n + spread) * scale)), i: 0, store: 0 }));
  const allpasses = [556, 441, 341, 225].map((n) => ({ buf: new Float32Array(Math.round((n + spread) * scale)), i: 0 }));
  const output = new Float32Array(N);
  for (let n = 0; n < N; n += 1) {
    const x = input[n] * 0.015;
    let sum = 0;
    for (const comb of combs) {
      const y = comb.buf[comb.i];
      comb.store = y * 0.7 + comb.store * 0.3;
      comb.buf[comb.i] = x + comb.store * 0.86;
      comb.i = (comb.i + 1) % comb.buf.length;
      sum += y;
    }
    for (const ap of allpasses) {
      const y = ap.buf[ap.i];
      ap.buf[ap.i] = sum + y * 0.5;
      ap.i = (ap.i + 1) % ap.buf.length;
      sum = y - sum;
    }
    output[n] = sum;
  }
  return output;
}
const wet = [reverb(send[0], 0), reverb(send[1], 23)];

// Compressão lateral: a batida "empurra" os sintetizadores, como na música eletrônica.
kicks.sort((a, b) => a - b);
const duck = new Float32Array(N).fill(1);
for (const t0 of kicks) {
  const i0 = Math.round(t0 * SR);
  for (let i = 0; i < SR * 0.35 && i0 + i < N; i += 1) duck[i0 + i] = Math.min(duck[i0 + i], 1 - 0.55 * Math.exp(-i / SR / 0.11));
}
// Queda da internet: a música fica abafada entre 14,7 s e 18 s.
const muffle = (t) => (t < 14.7 ? 18000 : t < 15.0 ? 18000 * (500 / 18000) ** range(t, 14.7, 15.0) : t < 17.5 ? 500 : t < 18 ? 500 * (18000 / 500) ** range(t, 17.5, 18) : 18000);
const busFilters = [new Filter(), new Filter()];
const mix = [new Float32Array(N), new Float32Array(N)];
for (let n = 0; n < N; n += 1) {
  const t = n / SR;
  const cutoff = muffle(t);
  for (let c = 0; c < 2; c += 1) {
    const music = busFilters[c].run(synth[c][n] * duck[n], cutoff, 0.7) * 0.8 + drums[c][n] * 0.85;
    let value = music + fx[c][n] + wet[c][n] * 0.9;
    value *= Math.min(1, t / 0.02) * (1 - range(t, 44.3, 45));
    mix[c][n] = Math.tanh(value * 1.1) / Math.tanh(1.1);
  }
}
let peak = 0;
for (let c = 0; c < 2; c += 1) for (let n = 0; n < N; n += 1) peak = Math.max(peak, Math.abs(mix[c][n]));

// WAV 16 bits, 48 kHz, estéreo.
const wav = Buffer.alloc(44 + N * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 4, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(N * 4, 40);
const norm = 0.89 / Math.max(peak, 1e-6);
for (let n = 0; n < N; n += 1) {
  wav.writeInt16LE(Math.round(clamp(mix[0][n] * norm, -1, 1) * 32767), 44 + n * 4);
  wav.writeInt16LE(Math.round(clamp(mix[1][n] * norm, -1, 1) * 32767), 46 + n * 4);
}
const audio = join(here, 'out', 'malha-45s.wav');
writeFileSync(audio, wav);
console.log(audio);

// Junta com a imagem, normalizando a sonoridade para -14 LUFS (padrão de YouTube e redes sociais).
const video = join(here, 'out', 'malha-45s-imagem.mp4');
if (existsSync(video)) {
  const measure = spawnSync('ffmpeg', ['-hide_banner', '-i', audio, '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const stats = JSON.parse(measure.stderr.slice(measure.stderr.lastIndexOf('{')));
  const filter = `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`;
  const final = join(here, 'out', 'malha-45s.mp4');
  const mux = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', filter, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', final], { stdio: 'inherit' });
  if (mux.status !== 0) throw new Error('ffmpeg não juntou imagem e som.');
  console.log(final);
} else {
  console.log(`Imagem não encontrada em ${video}: rode node video/render.mjs antes.`);
}
