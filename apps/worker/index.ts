import { setTimeout as wait } from 'node:timers/promises';
import { evaluateAll } from '../web/src/server/alerts';
import { connectPostgres } from '../web/src/server/db';
import { applyRetention } from '../web/src/server/exports';
import { emitMetrics, errorName, log } from '../web/src/server/log';
import { operationalMetrics } from '../web/src/server/operations';
import { sendPendingNotifications, transportFromEnv } from '../web/src/server/notifications';
import { processInventoryJob } from '../web/src/server/projection';
import { dispatchChannelNotifications } from '../web/src/server/push';

const EVALUATION_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = 60 * 60_000;

async function run() {
  if (process.env.MALHA_MODE !== 'pilot') throw new Error('Execute o worker com MALHA_MODE=pilot.');
  const db = connectPostgres(process.env.DATABASE_URL);
  const transport = transportFromEnv();
  const signal = new AbortController();
  process.once('SIGTERM', () => signal.abort());
  process.once('SIGINT', () => signal.abort());
  let nextEvaluation = 0;
  let nextRetention = 0;
  try {
    while (!signal.signal.aborted) {
      // A avaliação roda a cada minuto mesmo sem mensagens na fila, para detectar ausência de heartbeat.
      if (Date.now() >= nextEvaluation) {
        nextEvaluation = Date.now() + EVALUATION_INTERVAL_MS;
        try {
          const evaluation = await evaluateAll(db);
          const sent = await sendPendingNotifications(db, transport);
          if (evaluation && (evaluation.opened || evaluation.resolved || sent)) log.info('Ocorrências avaliadas', { ...evaluation, emailsSent: sent });
        } catch (error) {
          log.error('Falha ao avaliar ocorrências', { error: errorName(error) });
        }
        try {
          // Canais por grupo (Telegram e e-mail): outbox própria com retentativa e limite por canal.
          const pushed = await dispatchChannelNotifications(db, { transport });
          if (pushed.routed || pushed.sent || pushed.failed) log.info('Notificações de canal processadas', pushed);
        } catch (error) {
          log.error('Falha ao enviar notificações de canal', { error: errorName(error) });
        }
        try {
          const metrics = await operationalMetrics(db);
          emitMetrics(metrics, { OutboxOldestSeconds: 'Seconds', MaxCaptureAgeSeconds: 'Seconds', MaxClockSkewSeconds: 'Seconds' });
        } catch (error) {
          log.error('Falha ao coletar métricas de operação', { error: errorName(error) });
        }
      }
      if (Date.now() >= nextRetention) {
        nextRetention = Date.now() + RETENTION_INTERVAL_MS;
        await applyRetention(db).catch((error: unknown) => log.error('Falha na retenção de dados', { error: errorName(error) }));
      }
      try {
        if (await processInventoryJob(db)) continue;
      } catch (error) {
        log.error('Fila de inventário indisponível', { error: errorName(error) });
      }
      await wait(1500, undefined, { signal: signal.signal }).catch((error: unknown) => {
        if (!signal.signal.aborted) throw error;
      });
    }
  } finally {
    await db.close();
  }
}

void run().catch((error: unknown) => {
  log.error('Falha ao iniciar o worker', { error: errorName(error), detail: error instanceof Error ? error.message : null });
  process.exitCode = 1;
});
