import { listIntegrations } from '@/server/admin';
import { database } from '@/server/db';
import { handle, json } from '@/server/http';
import { principal } from '@/server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return handle(async () => json(await listIntegrations(await database(), await principal())));
}
