import { createFarm } from '@/server/admin';
import { database } from '@/server/db';
import { handle, json, parseJson, requestBytes } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handle(async () => {
    requireSameOrigin(request);
    const user = await principal();
    return json(await createFarm(await database(), user, parseJson(await requestBytes(request, 2048))), 201);
  });
}
