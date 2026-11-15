import { errorName, log } from './log';

export class HttpError extends Error {
  constructor(public status: number, message: string, public headers?: HeadersInit) { super(message); }
}

export function json(value: unknown, status = 200, options?: HeadersInit) {
  const headers = new Headers(options);
  headers.set('Cache-Control', 'no-store');
  return Response.json(value, { status, headers });
}

export async function handle(operation: () => Promise<Response>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status, error.headers);
    log.error('Falha na operação Malha', { error: errorName(error) });
    return json({ error: 'Operação indisponível. Tente novamente.' }, 500);
  }
}

export async function requestBytes(request: Request, limit: number) {
  const declared = request.headers.get('Content-Length');
  if (declared && Number(declared) > limit) throw new HttpError(413, 'Conteúdo maior que o limite permitido.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Envie o corpo da requisição.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Conteúdo maior que o limite permitido.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export function parseJson(body: Uint8Array) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
