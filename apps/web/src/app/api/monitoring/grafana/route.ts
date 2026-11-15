import { database } from '@/server/db';
import { handle, HttpError } from '@/server/http';
import { principal, rejectCrossSite } from '@/server/identity';
import { grafanaExport, planMonitoring, recordMonitoringExport } from '@/server/monitoring';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  return handle(async () => {
    rejectCrossSite(request);
    const db = await database();
    const user = await principal();
    const params = new URL(request.url).searchParams;
    const family = params.get('family');
    if (!family) throw new HttpError(400, 'Informe a família do painel.');
    params.set('families', family);
    params.delete('family');
    const plan = await planMonitoring(db, user, params);
    const [file] = grafanaExport(user.orgId, plan);
    if (!file) throw new HttpError(404, 'Nenhum ativo com IP nesta família.');
    await recordMonitoringExport(db, user, 'grafana', plan);
    return new Response(JSON.stringify(file.dashboard, null, 2), { headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  });
}
