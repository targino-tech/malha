import type { NextConfig } from 'next';
import { resolve } from 'node:path';

// Política de conteúdo das páginas pré-renderizadas (site público, erros): só o próprio site carrega scripts,
// estilos, fontes e conexões, e nada pode embutir o Malha. Página estática não recebe nonce, então os scripts
// inline do Next precisam de 'unsafe-inline' aqui. O painel (/) e o portal (/entrar) recebem a política com
// nonce por requisição em src/proxy.ts. Em dev, o HMR exige 'unsafe-eval'.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  turbopack: { root: resolve(import.meta.dirname, '../..') },
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  ...(process.env.MALHA_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  async redirects() {
    return [{ source: '/site/planos', destination: '/site/open-source', permanent: true }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
      {
        // Tudo menos / e /entrar, que recebem a política com nonce no proxy.
        source: '/:path((?!entrar$).+)',
        headers: [{ key: 'Content-Security-Policy', value: contentSecurityPolicy }],
      },
      {
        source: '/:path((?!site(?:/|$)).*)',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default nextConfig;
