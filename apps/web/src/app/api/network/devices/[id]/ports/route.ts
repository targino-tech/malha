import { database } from '@/server/db';
import { handle, json } from '@/server/http';
import { principal } from '@/server/identity';
import { devicePorts } from '@/server/network/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await principal();
    const { id } = await params;
    return json(await devicePorts(await database(), user, id));
  });
}
