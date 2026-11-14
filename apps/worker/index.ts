import { setTimeout as wait } from 'node:timers/promises';
import { connectPostgres } from '../web/src/server/db';
import { processInventoryJob } from '../web/src/server/projection';

async function run() {
  if (process.env.MALHA_MODE !== 'pilot') throw new Error('Execute o worker com MALHA_MODE=pilot.');
  const db = connectPostgres(process.env.DATABASE_URL);
  const signal = new AbortController();
  process.once('SIGTERM', () => signal.abort());
  process.once('SIGINT', () => signal.abort());
  try {
    while (!signal.signal.aborted) {
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
