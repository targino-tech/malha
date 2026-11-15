import { setAssetArchived } from '@/server/assets';
import { database } from '@/server/db';
import { handle, json, parseJson, requestBytes } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';

export const runtime = 'nodejs';

export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    requireSameOrigin(request);
    const user = await principal();
    const { id } = await params;
    return json(await setAssetArchived(await database(), user, id, parseJson(await requestBytes(request, 1024))));
  });
}
