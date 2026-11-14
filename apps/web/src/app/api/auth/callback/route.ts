import { handle } from '@/server/http';
import { finishLogin } from '@/server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) { return handle(() => finishLogin(request)); }
