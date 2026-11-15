import { database } from '@/server/db';
import { handle, HttpError, json } from '@/server/http';
import { principal, requireSameOrigin } from '@/server/identity';
import { applyGrafana, applyZabbix } from '@/server/monitoring-apply';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(request: Request) {
  return handle(async () => {
    requireSameOrigin(request);
    const params = new URL(request.url).searchParams;
    const target = params.get('target');
    params.delete('target');
    if (target === 'zabbix') return json(await applyZabbix(await database(), await principal(), params));
    if (target === 'grafana') return json(await applyGrafana(await database(), await principal(), params));
    throw new HttpError(400, 'Destino desconhecido.');
  });
}
