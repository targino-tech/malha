import { database } from '@/server/db';
import { handle, HttpError, json, parseJson, requestBytes } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';
import { listConnections, removeConnection, saveConnection } from '@/server/monitoring-apply';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return handle(async () => json(await listConnections(await database(), await principal())));
}

export function PUT(request: Request) {
  return handle(async () => {
    requireSameOrigin(request);
    return json(await saveConnection(await database(), await principal(), parseJson(await requestBytes(request, 16 * 1024))));
  });
}

export function DELETE(request: Request) {
  return handle(async () => {
    requireSameOrigin(request);
    const kind = new URL(request.url).searchParams.get('kind');
    if (kind !== 'zabbix' && kind !== 'grafana') throw new HttpError(400, 'Integração desconhecida.');
    await removeConnection(await database(), await principal(), kind);
    return json({ removed: kind });
  });
}
