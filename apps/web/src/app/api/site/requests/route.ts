import { handle, json } from '@/server/http';
import { createSiteRequest } from '@/server/site-requests';

export const runtime = 'nodejs';

export function POST(request: Request) { return handle(async () => json(await createSiteRequest(request), 201)); }
