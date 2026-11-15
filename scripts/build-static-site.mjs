// Gera a versão estática do site público para o GitHub Pages (https://<usuario>.github.io/malha/).
// O app completo precisa de servidor; aqui ficam só as páginas de /site, com portal e cadastro apontando
// para o repositório. Uso: node scripts/build-static-site.mjs  →  apps/site-static/out
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const base = process.env.MALHA_PAGES_BASE ?? '/malha';
const target = join(root, 'apps/site-static');
const app = join(target, 'src/app');

rmSync(target, { recursive: true, force: true });
cpSync(join(root, 'apps/web'), target, {
  recursive: true,
  filter: (source) => !/[\\/](\.next|node_modules|out)([\\/]|$)/.test(source),
});

// Só o site: painel, API, portal e ingestão dependem de servidor.
for (const path of ['api', 'v1', 'entrar', 'page.tsx', 'error.tsx', 'loading.tsx']) rmSync(join(app, path), { recursive: true, force: true });
const refresh = (to) => `export default function Redirect() {
  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: '#040705', color: '#ecf4e8', fontFamily: 'system-ui, sans-serif' }}>
      <meta httpEquiv="refresh" content="0; url=${base}${to}" />
      <a href="${base}${to}" style={{ color: '#b6f37a' }}>Abrir o site do Malha</a>
    </main>
  );
}
`;
writeFileSync(join(app, 'page.tsx'), refresh('/site/'));
rmSync(join(app, 'site/planos'), { recursive: true, force: true });
mkdirSync(join(app, 'site/planos'), { recursive: true });
writeFileSync(join(app, 'site/planos/page.tsx'), refresh('/site/open-source/'));

// Arquivos de public/ passam a ficar sob o basePath; URLs absolutas no CSS não recebem o prefixo sozinhas.
for (const file of ['site/site.module.css', 'globals.css', 'site/layout.tsx']) {
  const path = join(app, file);
  if (existsSync(path)) writeFileSync(path, readFileSync(path, 'utf8').replaceAll("'/malha/", `'${base}/malha/`).replaceAll('"/malha/', `"${base}/malha/`));
}

writeFileSync(join(target, 'next.config.ts'), `import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const config: NextConfig = {
  output: 'export',
  basePath: '${base}',
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  devIndicators: false,
  turbopack: { root: resolve(import.meta.dirname, '../..') },
};

export default config;
`);

execFileSync(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'build', target], {
  stdio: 'inherit', env: { ...process.env, NEXT_PUBLIC_MALHA_STATIC: '1', NEXT_TELEMETRY_DISABLED: '1' },
});
writeFileSync(join(target, 'out/.nojekyll'), '');
console.log(`Site estático em ${join(target, 'out')} (base ${base}).`);
