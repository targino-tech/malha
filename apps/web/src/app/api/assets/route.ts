import { createAsset, listAssets } from '@/server/assets';
import { database } from '@/server/db';
import { handle, json, parseJson, requestBytes } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  return handle(async () => json(await listAssets(await database(), await principal(), new URL(request.url).searchParams)));
}

export function POST(request: Request) {
  return handle(async () => {
    requireSameOrigin(request);
    const user = await principal();
    return json(await createAsset(await database(), user, parseJson(await requestBytes(request, 8192))), 201);
  });
}
