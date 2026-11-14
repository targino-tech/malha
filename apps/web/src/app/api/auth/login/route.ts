import { handle } from '@/server/http';
import { startLogin } from '@/server/identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() { return handle(startLogin); }
