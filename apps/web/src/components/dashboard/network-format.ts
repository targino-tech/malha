/**
 * Formatação pt-BR e geometria dos gráficos de rede. Sem dependências de React, para ser testada direto.
 * Taxas em bits por segundo e volumes em bytes, ambos em múltiplos decimais (1 k = 1.000), como os equipamentos de rede informam.
 */

const NBSP = ' ';
const BIT_UNITS = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s', 'Tbit/s'];
const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

function scaled(value: number, units: string[]) {
  if (!Number.isFinite(value) || value <= 0) return `0${NBSP}${units[0]}`;
  const exponent = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log10(value) / 3)));
  let amount = value / 1000 ** exponent;
  let unit = exponent;
  // 999,96 arredondaria para "1.000": sobe de unidade antes.
  if (amount >= 999.95 && unit < units.length - 1) { amount /= 1000; unit += 1; }
  const digits = amount >= 100 || unit === 0 ? 0 : 1;
  const text = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(amount);
  return `${text}${NBSP}${units[unit]}`;
}

/** 1234567 → "1,2 Mbit/s". */
export const formatBits = (bps: number) => scaled(bps, BIT_UNITS);
/** 1500000000 → "1,5 GB". */
export const formatBytes = (bytes: number) => scaled(bytes, BYTE_UNITS);

const percentFormat = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: 1 });
/** 0,375 → "37,5%". */
export const formatPercent = (ratio: number) => percentFormat.format(Number.isFinite(ratio) ? ratio : 0);

const wattFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
/** 12400 mW → "12,4 W". */
export const formatPower = (milliwatts: number) => `${wattFormat.format(milliwatts / 1000)}${NBSP}W`;

export const formatCount = (value: number) => new Intl.NumberFormat('pt-BR').format(value);

/** Teto "redondo" do eixo para taxas: 1, 2, 2,5 ou 5 × 10ⁿ. */
export function niceCeiling(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) if (value <= factor * step * (1 + 1e-9)) return factor * step;
  return 10 * step;
}

export type Sample = { x: number; y: number };

/**
 * Divide a série em trechos contínuos: dois pontos separados por mais de `maxGap` ficam em trechos diferentes,
 * para a lacuna aparecer como lacuna e não como uma reta ligando os dois lados.
 */
export function segments<T extends { t: string }>(points: T[], maxGapMs: number): T[][] {
  const result: T[][] = [];
  let current: T[] = [];
  let last = -Infinity;
  for (const point of points) {
    const at = Date.parse(point.t);
    if (current.length && at - last > maxGapMs) { result.push(current); current = []; }
    current.push(point);
    last = at;
  }
  if (current.length) result.push(current);
  return result;
}

/**
 * Distância a partir da qual dois pontos são lacuna: 2,5 × o maior entre o intervalo de agrupamento e o espaçamento
 * típico (mediana) da série. Coletas a cada 15 min agrupadas em 5 min não viram lacunas.
 */
export function gapThreshold(points: Array<{ t: string }>, bucketSeconds: number) {
  const diffs = points.slice(1).map((point, index) => Date.parse(point.t) - Date.parse(points[index].t)).sort((a, b) => a - b);
  const median = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
  return Math.max(bucketSeconds * 1000, median) * 2.5;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Linha SVG ("M x y L …") de um trecho já em coordenadas de tela. */
export function linePath(samples: Sample[]) {
  return samples.map((sample, index) => `${index ? 'L' : 'M'}${round(sample.x)} ${round(sample.y)}`).join('');
}

/** Área fechada até a base `baseline`. Um ponto isolado vira uma faixa estreita para continuar visível. */
export function areaPath(samples: Sample[], baseline: number, minWidth = 2) {
  if (!samples.length) return '';
  const first = samples[0];
  const last = samples.at(-1)!;
  const line = samples.length === 1
    ? `M${round(first.x - minWidth / 2)} ${round(first.y)}L${round(first.x + minWidth / 2)} ${round(first.y)}`
    : linePath(samples);
  const end = samples.length === 1 ? first.x + minWidth / 2 : last.x;
  const start = samples.length === 1 ? first.x - minWidth / 2 : first.x;
  return `${line}L${round(end)} ${round(baseline)}L${round(start)} ${round(baseline)}Z`;
}

/** Converte instantes e valores em coordenadas, com o tempo na horizontal entre `from` e `to`. */
export function project<T extends { t: string }>(points: T[], value: (point: T) => number, frame: { from: number; to: number; width: number; height: number; max: number }) {
  const span = Math.max(1, frame.to - frame.from);
  return points.map((point) => ({
    x: ((Date.parse(point.t) - frame.from) / span) * frame.width,
    y: frame.height - (Math.max(0, value(point)) / Math.max(1, frame.max)) * frame.height,
  }));
}

/** Índice do ponto mais próximo de uma posição horizontal (0–1) no período. */
export function nearestIndex(points: Array<{ t: string }>, ratio: number, from: number, to: number) {
  if (!points.length) return -1;
  const target = from + ratio * (to - from);
  let best = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (Math.abs(Date.parse(points[index].t) - target) < Math.abs(Date.parse(points[best].t) - target)) best = index;
  }
  return best;
}

/** Faixa da escala de utilização (0 a 4) para a tira de calor; nula sem medição. */
export function heatLevel(ratio: number | null): 0 | 1 | 2 | 3 | 4 | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  if (ratio < 0.05) return 0;
  if (ratio < 0.25) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.75) return 3;
  return 4;
}

export const HEAT_LEVELS = ['Abaixo de 5%', '5% a 25%', '25% a 50%', '50% a 75%', '75% ou mais'] as const;
