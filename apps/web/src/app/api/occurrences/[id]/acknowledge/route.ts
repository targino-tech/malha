import { database } from '@/server/db';
import { handle, json } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';
import { acknowledgeOccurrence } from '@/server/occurrences';

export const runtime = 'nodejs';

export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    requireSameOrigin(request);
    const user = await principal();
    const { id } = await params;
    return json(await acknowledgeOccurrence(await database(), user, id));
  });
}
