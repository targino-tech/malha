import { listDeliveries } from '@/server/alert-channels';
import { database } from '@/server/db';
import { handle, json } from '@/server/http';
import { principal } from '@/server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  return handle(async () => json(await listDeliveries(await database(), await principal(), new URL(request.url).searchParams)));
}
