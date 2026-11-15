import { database } from '@/server/db';
import { handle, json, parseJson, requestBytes } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';
import { saveBaseline } from '@/server/metrics';

export const runtime = 'nodejs';

export function PUT(request: Request) {
  return handle(async () => {
    requireSameOrigin(request);
    const user = await principal();
    return json(await saveBaseline(await database(), user, parseJson(await requestBytes(request, 2048))));
  });
}
