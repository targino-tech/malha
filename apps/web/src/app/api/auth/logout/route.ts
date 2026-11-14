import { handle } from '@/server/http';
import { logout } from '@/server/identity';

export const runtime = 'nodejs';

export function POST(request: Request) { return handle(() => logout(request)); }
