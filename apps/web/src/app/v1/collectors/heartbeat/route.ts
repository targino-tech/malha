import { acceptHeartbeat } from '@/server/collector';
import { handle, json } from '@/server/http';

export const runtime = 'nodejs';

export function POST(request: Request) { return handle(async () => json(await acceptHeartbeat(request))); }
