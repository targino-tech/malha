import { database } from '@/server/db';
import { handle, json } from '@/server/http';
import { principal } from '@/server/identity';
import { networkPanel } from '@/server/network/panel';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  return handle(async () => json(await networkPanel(await database(), await principal(), new URL(request.url).searchParams)));
}
