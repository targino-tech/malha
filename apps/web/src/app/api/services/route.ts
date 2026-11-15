import { database } from '@/server/db';
import { handle, json, parseJson, requestBytes } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';
import { recordService } from '@/server/metrics';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handle(async () => {
    requireSameOrigin(request);
    const user = await principal();
    return json(await recordService(await database(), user, parseJson(await requestBytes(request, 4096))), 201);
  });
}
