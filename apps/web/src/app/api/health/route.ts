import { database } from '@/server/db';
import { json } from '@/server/http';
import { errorName, log } from '@/server/log';
import { databaseReachable } from '@/server/operations';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Health check do ALB e do smoke test. Não exige sessão e não expõe dados de clientes. */
export async function GET() {
  try {
    if (await databaseReachable(await database())) return json({ status: 'ok' });
  } catch (error) {
    log.error('Health check sem banco', { error: errorName(error) });
  }
  return json({ status: 'unavailable' }, 503);
}
