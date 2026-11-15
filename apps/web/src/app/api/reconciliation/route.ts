import { database } from '@/server/db';
import { handle, json, parseJson, requestBytes } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';
import { reconcile, reconciliationQueue } from '@/server/reconciliation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return handle(async () => json(await reconciliationQueue(await database(), await principal())));
}

export function POST(request: Request) {
  return handle(async () => {
    requireSameOrigin(request);
    const user = await principal();
    return json(await reconcile(await database(), user, parseJson(await requestBytes(request, 2048))));
  });
}
