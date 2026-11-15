import { database } from '@/server/db';
import { handle, json } from '@/server/http';
import { principal } from '@/server/identity';
import { geo } from '@/server/network/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  return handle(async () => json(await geo(await database(), await principal(), new URL(request.url).searchParams)));
}
