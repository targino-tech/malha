import { setTimeout as wait } from 'node:timers/promises';
import { evaluateAll } from '../web/src/server/alerts';
import { connectPostgres } from '../web/src/server/db';
import { applyRetention } from '../web/src/server/exports';
import { sendPendingNotifications, transportFromEnv } from '../web/src/server/notifications';
import { processInventoryJob } from '../web/src/server/projection';

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
          await evaluateAll(db);
          await sendPendingNotifications(db, transport);
        } catch (error) {
          console.error('Falha ao avaliar ocorrências', error instanceof Error ? error.name : 'indefinida');
        }
      }
      if (Date.now() >= nextRetention) {
        nextRetention = Date.now() + RETENTION_INTERVAL_MS;
        await applyRetention(db).catch((error: unknown) => {
          console.error('Falha na retenção de dados', error instanceof Error ? error.name : 'indefinida');
        });
      }
      try {
        if (await processInventoryJob(db)) continue;
      } catch (error) {
        console.error('Fila de inventário indisponível', error instanceof Error ? error.name : 'indefinida');
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
  console.error(error instanceof Error ? error.message : 'Falha ao iniciar o worker');
  process.exitCode = 1;
});
