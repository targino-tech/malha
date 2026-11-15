import { createChannel, listChannels } from '@/server/alert-channels';
import { database } from '@/server/db';
import { handle, json, parseJson, requestBytes } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return handle(async () => json(await listChannels(await database(), await principal())));
}

export function POST(request: Request) {
  return handle(async () => {
    requireSameOrigin(request);
    return json(await createChannel(await database(), await principal(), parseJson(await requestBytes(request, 32 * 1024))), 201);
  });
}
