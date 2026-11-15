import { database } from '@/server/db';
import { listAudit } from '@/server/exports';
import { handle, json } from '@/server/http';
import { principal } from '@/server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  return handle(async () => json(await listAudit(await database(), await principal(), new URL(request.url).searchParams)));
}
