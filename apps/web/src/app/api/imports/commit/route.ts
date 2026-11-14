import { handle, json } from '@/server/http';
import { commitImport } from '@/server/imports';

export const runtime = 'nodejs';

export function POST(request: Request) { return handle(async () => json(await commitImport(request))); }
