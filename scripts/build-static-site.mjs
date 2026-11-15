// Gera a versão estática do site público para o GitHub Pages (https://<usuario>.github.io/malha/).
// O app completo precisa de servidor; aqui ficam só as páginas de /site, com portal e cadastro apontando
// para o repositório. Uso: node scripts/build-static-site.mjs  →  apps/site-static/out
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  let source;
  try { source = readFileSync(path, 'utf8'); } catch { continue; }
  writeFileSync(path, source.replaceAll("'/malha/", `'${base}/malha/`).replaceAll('"/malha/', `"${base}/malha/`));
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

// Página do vídeo de apresentação: /malha/video/ com o MP4 do repositório (docs/media/video).
const media = join(root, 'docs/media/video');
let hasVideo = true;
try {
  mkdirSync(join(target, 'out/video'), { recursive: true });
  for (const file of ['malha-45s.mp4', 'capa.jpg']) cpSync(join(media, file), join(target, 'out/video', file));
} catch {
  hasVideo = false;
}
if (hasVideo) {
  writeFileSync(join(target, 'out/video/index.html'), `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Malha · vídeo de apresentação</title>
<meta name="description" content="Vídeo de 45 segundos do Malha, inventário de rede e ativos para grupos agrícolas. Open source sob a AGPL-3.0.">
<meta property="og:title" content="Malha · vídeo de apresentação">
<meta property="og:image" content="capa.jpg">
<meta property="og:video" content="malha-45s.mp4">
<style>
  @font-face { font-family: 'Barlow Condensed'; src: url('../malha/barlow-condensed-700.woff2') format('woff2'); font-weight: 700; }
  :root { color-scheme: dark; --page: #040705; --text: #ecf4e8; --muted: #92a595; --forest: #b6f37a; --wheat: #d9b866; --line: #1f3324; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--page); color: var(--text); font: 17px/1.5 Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  main { width: min(100% - 32px, 1120px); margin: 0 auto; padding: 48px 0 64px; }
  .eyebrow { font: 600 13px ui-monospace, Menlo, Consolas, monospace; letter-spacing: .28em; color: var(--wheat); text-transform: uppercase; }
  h1 { font-family: 'Barlow Condensed', 'Arial Narrow', sans-serif; font-size: clamp(40px, 7vw, 76px); line-height: .95; text-transform: uppercase; margin: 14px 0 12px; }
  h1 span { color: var(--forest); }
  p { color: var(--muted); max-width: 60ch; margin: 0 0 28px; }
  video { display: block; width: 100%; aspect-ratio: 16 / 9; border: 1px solid var(--line); border-radius: 18px; background: #000; }
  nav { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
  a { color: var(--text); }
  nav a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 18px; border: 1px solid #2a3f2e; border-radius: 999px; text-decoration: none; }
  nav a:first-child { background: var(--forest); color: #040705; border-color: var(--forest); font-weight: 600; }
  a:focus-visible { outline: 3px solid var(--forest); outline-offset: 3px; }
  small { display: block; margin-top: 18px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="eyebrow">Malha · 45 segundos</div>
  <h1>A rede do campo, <span>à vista da matriz.</span></h1>
  <p>Coleta somente leitura do UniFi, alerta em 3 minutos, Zabbix e Grafana montados do inventário e login corporativo. Grátis e open source.</p>
  <video controls preload="metadata" poster="capa.jpg" playsinline>
    <source src="malha-45s.mp4" type="video/mp4">
    <a href="malha-45s.mp4">Baixar o vídeo (MP4)</a>
  </video>
  <nav>
    <a href="../site/">Conhecer o Malha</a>
    <a href="https://github.com/targino-tech/malha">Código no GitHub</a>
    <a href="malha-45s.mp4" download>Baixar MP4 (19 MB)</a>
  </nav>
  <small>Telas e fazendas do vídeo são dados de demonstração. Trilha e efeitos sintetizados pelo próprio projeto.</small>
</main>
</body>
</html>
`);
}
console.log(`Site estático em ${join(target, 'out')} (base ${base}).`);
