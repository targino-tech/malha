/**
 * Taxas a partir de contadores acumulados de bytes. Trata reinício do contador, estouro de 32 ou 64 bits,
 * intervalos longos demais e leituras fora de ordem, sem inventar tráfego quando a diferença é ambígua.
 */

export const MAX_RATE_BPS = 400e9;
/** Acima deste intervalo a média perde sentido para o painel: a amostra é descartada. */
export const MAX_GAP_SECONDS = 3600;
const WRAP_32 = 2 ** 32;
const WRAP_64 = 2n ** 64n;

export type CounterReading = { observedAt: string | Date; rxBytes: number | null; txBytes: number | null };
export type RateResult =
  | { ok: true; rxBps: number; txBps: number; intervalSeconds: number; wrapped: boolean }
  | { ok: false; reason: 'order' | 'gap' | 'reset' | 'implausible' | 'missing' };

/** Diferença de um contador, considerando estouro. Devolve nulo quando parece reinício (reboot) do contador. */
export function counterDelta(previous: number, current: number, seconds: number, maxBps = MAX_RATE_BPS): { delta: number; wrapped: boolean } | null {
  if (current >= previous) return { delta: current - previous, wrapped: false };
  const limit = (maxBps / 8) * seconds;
  // Estouro de 32 bits: o anterior cabia em 32 bits e a volta é plausível para o intervalo.
  if (previous < WRAP_32) {
    const delta = WRAP_32 - previous + current;
    if (delta <= limit) return { delta, wrapped: true };
  }
  // Estouro de 64 bits: só é plausível perto do teto. Contadores acima de 2^53 chegam arredondados.
  const delta64 = Number(WRAP_64 - BigInt(Math.round(previous)) + BigInt(Math.round(current)));
  if (previous >= 2 ** 63 && delta64 <= limit) return { delta: delta64, wrapped: true };
  return null;
}

export function computeRate(previous: CounterReading, current: CounterReading, maxBps = MAX_RATE_BPS): RateResult {
  const seconds = (new Date(current.observedAt).getTime() - new Date(previous.observedAt).getTime()) / 1000;
  if (!(seconds > 0)) return { ok: false, reason: 'order' };
  if (seconds > MAX_GAP_SECONDS) return { ok: false, reason: 'gap' };
  if (previous.rxBytes === null || previous.txBytes === null || current.rxBytes === null || current.txBytes === null) {
    return { ok: false, reason: 'missing' };
  }
  const rx = counterDelta(previous.rxBytes, current.rxBytes, seconds, maxBps);
  const tx = counterDelta(previous.txBytes, current.txBytes, seconds, maxBps);
  if (!rx || !tx) return { ok: false, reason: 'reset' };
  const rxBps = Math.round((rx.delta * 8) / seconds);
  const txBps = Math.round((tx.delta * 8) / seconds);
  if (rxBps > maxBps || txBps > maxBps) return { ok: false, reason: 'implausible' };
  return { ok: true, rxBps, txBps, intervalSeconds: Math.round(seconds), wrapped: rx.wrapped || tx.wrapped };
}

export type RateSample = { observedAt: string; rxBps: number; txBps: number; intervalSeconds: number };

/**
 * Recalcula as amostras de uma série a partir das leituras conhecidas, em ordem de tempo. Uma leitura que chega
 * atrasada entra no meio da série e divide o intervalo: a amostra seguinte passa a medir só o trecho restante.
 * A amostra é registrada no instante final do intervalo.
 */
export function ratesFromReadings(readings: CounterReading[], maxBps = MAX_RATE_BPS): RateSample[] {
  const sorted = [...readings].sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
  const samples: RateSample[] = [];
  for (let index = 1; index < sorted.length; index++) {
    const result = computeRate(sorted[index - 1], sorted[index], maxBps);
    if (result.ok) {
      samples.push({ observedAt: new Date(sorted[index].observedAt).toISOString(), rxBps: result.rxBps, txBps: result.txBps, intervalSeconds: result.intervalSeconds });
    }
  }
  return samples;
}
