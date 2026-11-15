import { deactivateMember, saveMember } from '@/server/admin';
import { database } from '@/server/db';
import { handle, json, parseJson, requestBytes } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';

export const runtime = 'nodejs';

type Context = { params: Promise<{ oid: string }> };

export function PUT(request: Request, { params }: Context) {
  return handle(async () => {
    requireSameOrigin(request);
    const user = await principal();
    const { oid } = await params;
    return json(await saveMember(await database(), user, oid, parseJson(await requestBytes(request, 16_384))));
  });
}

export function DELETE(request: Request, { params }: Context) {
  return handle(async () => {
    requireSameOrigin(request);
    const user = await principal();
    const { oid } = await params;
    return json(await deactivateMember(await database(), user, oid));
  });
}
