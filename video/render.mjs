// Gera o vídeo do Malha: empacota as cenas, abre no Chromium e grava cada quadro direto no ffmpeg.
//
//   node video/render.mjs                    → video/out/malha-45s.mp4 (1920 × 1080, 60 fps)
//   node video/render.mjs --fps 30           → mais rápido, para revisar
//   node video/render.mjs --from 12 --to 20  → só um trecho
//   node video/render.mjs --still 16.8       → um quadro em PNG (video/out/quadro-16.8.png)
//
// Requer ffmpeg no PATH. Para usar um Chromium já instalado: MALHA_CHROMIUM=/caminho/do/chromium.
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const fps = Number(option('fps', '60'));
const still = option('still');
const out = resolve(option('out', join(here, 'out', 'malha-45s.mp4')));

await build({ entryPoints: [join(here, 'src', 'main.ts')], bundle: true, format: 'iife', target: 'chrome120', outfile: join(here, 'dist', 'main.js'), logLevel: 'warning' });
await mkdir(join(here, 'out'), { recursive: true });

// Servidor local só para esta execução: fontes não carregam por file://.
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webp': 'image/webp', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const path = resolve(root, `.${decodeURIComponent(new URL(request.url ?? '/', 'http://local').pathname)}`);
  if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  let body;
  try { body = await readFile(path); } catch { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address();

const browser = await chromium.launch(process.env.MALHA_CHROMIUM ? { executablePath: process.env.MALHA_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${port}/video/index.html?render`, { waitUntil: 'networkidle' });
const duration = await page.evaluate(async () => { await window.malhaVideo.ready; return window.malhaVideo.duration; });

try {
  if (still) {
    await page.evaluate((t) => window.malhaVideo.seek(t), Number(still));
    const file = join(here, 'out', `quadro-${still}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  } else {
    const from = Number(option('from', '0'));
    const to = Math.min(duration, Number(option('to', String(duration))));
    const total = Math.round((to - from) * fps);
    const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const finished = new Promise((done, fail) => ffmpeg.on('close', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg saiu com ${code}`)))));
    const started = Date.now();
    for (let index = 0; index < total; index += 1) {
      await page.evaluate((t) => window.malhaVideo.seek(t), from + index / fps);
      const frame = await page.screenshot({ type: 'png' });
      if (!ffmpeg.stdin.write(frame)) await new Promise((done) => ffmpeg.stdin.once('drain', done));
      if (index % fps === 0) process.stdout.write(`\r${Math.round((index / total) * 100)}% · ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
    ffmpeg.stdin.end();
    await finished;
    console.log(`\n${out}`);
  }
} finally {
  await browser.close();
  server.close();
}
