import { database } from '@/server/db';
import { exportAssets } from '@/server/exports';
import { handle } from '@/server/http';
import { principal } from '@/server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  return handle(async () => {
    const file = await exportAssets(await database(), await principal(), new URL(request.url).searchParams);
    return new Response(file.body, { headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  });
}
