import { enrollCollector } from '@/server/collector';
import { handle, json } from '@/server/http';

export const runtime = 'nodejs';

export function POST(request: Request) { return handle(async () => json(await enrollCollector(request), 201)); }
