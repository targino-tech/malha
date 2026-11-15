import { database } from '@/server/db';
import { handle } from '@/server/http';
import { principal } from '@/server/identity';
import { planMonitoring, recordMonitoringExport, zabbixExport } from '@/server/monitoring';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  return handle(async () => {
    const db = await database();
    const user = await principal();
    const plan = await planMonitoring(db, user, new URL(request.url).searchParams);
    await recordMonitoringExport(db, user, 'zabbix', plan);
    return new Response(JSON.stringify(zabbixExport(user.orgId, plan), null, 2), { headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="malha-zabbix-${plan.model}.json"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  });
}
