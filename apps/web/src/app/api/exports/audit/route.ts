import { database } from '@/server/db';
import { downloadResponse, exportAudit } from '@/server/exports';
import { handle } from '@/server/http';
import { principal, rejectCrossSite } from '@/server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  return handle(async () => {
    rejectCrossSite(request);
    const file = await exportAudit(await database(), await principal(), new URL(request.url).searchParams);
    return downloadResponse(file);
  });
}
