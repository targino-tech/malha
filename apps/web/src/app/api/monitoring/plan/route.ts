import { database } from '@/server/db';
import { handle, json } from '@/server/http';
import { principal } from '@/server/identity';
import { catalogEntries, planMonitoring } from '@/server/monitoring';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  return handle(async () => {
    const plan = await planMonitoring(await database(), await principal(), new URL(request.url).searchParams);
    return json({ ...plan, catalog: catalogEntries() });
  });
}
