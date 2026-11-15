import { mode } from '@/server/db';
import { handle } from '@/server/http';
import { startOidcLogin } from '@/server/oidc';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  if (mode() === 'demo') return new Response(null, { status: 303, headers: { Location: '/' } });
  return handle(startOidcLogin);
}
