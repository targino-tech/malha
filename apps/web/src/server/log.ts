type Fields = Record<string, string | number | boolean | null | undefined>;

/**
 * Log estruturado em JSON por linha, lido pelo CloudWatch Logs. Nunca registre payloads de coleta,
 * e-mails, tokens ou dados de cadastro: só identificadores técnicos e nomes de erro.
 */
function write(level: 'info' | 'warn' | 'error', message: string, fields?: Fields) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, service: process.env.MALHA_SERVICE ?? 'malha', ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export const log = {
  info: (message: string, fields?: Fields) => write('info', message, fields),
  warn: (message: string, fields?: Fields) => write('warn', message, fields),
  error: (message: string, fields?: Fields) => write('error', message, fields),
};

export const errorName = (error: unknown) => error instanceof Error ? error.name : 'indefinida';

/**
 * Publica métricas no formato CloudWatch Embedded Metric Format: a linha de log vira métrica no
 * namespace Malha, sem SDK nem chamadas de rede a partir da aplicação.
 */
export function emitMetrics(metrics: Record<string, number>, unit: Record<string, 'Count' | 'Seconds'> = {}) {
  const environment = process.env.MALHA_ENVIRONMENT ?? 'local';
  console.info(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'Malha',
        Dimensions: [['Environment']],
        Metrics: Object.keys(metrics).map((name) => ({ Name: name, Unit: unit[name] ?? 'Count' })),
      }],
    },
    Environment: environment,
    ...metrics,
  }));
}
