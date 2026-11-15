import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content-Security-Policy com nonce para as páginas dinâmicas (painel e portal de entrada).
 * Cada requisição recebe um nonce novo; o Next lê o cabeçalho da requisição e aplica o nonce aos próprios
 * scripts. Com 'strict-dynamic', só roda script com o nonce certo ou carregado por um deles: um script
 * injetado por XSS fica bloqueado. O site público é pré-renderizado e usa a política do next.config.
 */
export function proxy(request: NextRequest) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
    // Estilos inline vêm do React e das animações; com nonce aqui o navegador ignoraria 'unsafe-inline'.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    { source: '/', missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }] },
    { source: '/entrar', missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }] },
  ],
};
