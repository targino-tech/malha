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

// O worker do MapLibre segue a CSP da própria resposta: ele busca tiles, glifos e sprites, então recebe as
// origens do mapa base em connect-src. Só esse arquivo; o restante do site mantém a política acima.
// O carregador do next.config não resolve imports locais: esta é a mesma regra de
// src/components/dashboard/geo/config.ts (mapCspOrigins), conferida em tests/mapa-geo.test.ts.
function mapCspOrigins() {
  const raw = (process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? '').trim() || 'https://tiles.openfreemap.org/styles/dark';
  if (raw.toLowerCase() === 'none' || raw.startsWith('/')) return [];
  const origins = new Set<string>();
  for (const value of (process.env.MALHA_MAP_EXTRA_ORIGINS ?? '').split(',').map((item) => item.trim())) {
    if (!value || value.includes('*')) continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password && value.replace(/\/$/, '') === url.origin) origins.add(url.origin);
    } catch { /* inválida: fica fora */ }
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return [];
    origins.add(url.origin);
  } catch {
    return [];
  }
  return [...origins];
}
const mapOrigins = mapCspOrigins();
const mapWorkerPolicy = [
  "default-src 'none'",
  `connect-src 'self'${mapOrigins.length ? ` ${mapOrigins.join(' ')}` : ''}`,
  "img-src 'self' data: blob:",
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
        source: '/_next/static/media/:file(maplibre-gl-worker\\.[0-9a-f]+\\.mjs)',
        headers: [{ key: 'Content-Security-Policy', value: mapWorkerPolicy }],
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
