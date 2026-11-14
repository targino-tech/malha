import { getDashboard } from '@/server/dashboard';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return handle(async () => json(await getDashboard()));
}
