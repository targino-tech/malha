import { createGlobe, MT_VIEW, wrap, type View } from './globe';

/**
 * Vídeo de 45 s do Malha (1920 × 1080). Tudo é função do instante `t`: o render.mjs chama
 * `malhaVideo.seek(t)` para cada quadro e captura a tela; abrindo o index.html no navegador,
 * o vídeo toca em loop para pré-visualizar.
 */

export const DURATION = 45;
const WIDTH = 1920;
const HEIGHT = 1080;

declare global {
  interface Window { malhaVideo: { duration: number; seek(t: number): void; ready: Promise<void> } }
}

// Curvas e intervalos.
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const range = (t: number, start: number, end: number) => clamp((t - start) / (end - start));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const outCubic = (x: number) => 1 - (1 - x) ** 3;
const inCubic = (x: number) => x ** 3;
const inOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const outExpo = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
const outBack = (x: number) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
/** Opacidade de um elemento que entra em [a, a+fadeIn] e sai em [b-fadeOut, b]. */
const life = (t: number, a: number, b: number, fadeIn = 0.5, fadeOut = 0.5) => outCubic(range(t, a, a + fadeIn)) * (1 - inCubic(range(t, b - fadeOut, b)));

function one<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Elemento ausente: ${selector}`);
  return element;
}
const all = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => [...root.querySelectorAll<T>(selector)];
const show = (element: HTMLElement | SVGElement, opacity: number, transform = '') => {
  element.style.opacity = opacity.toFixed(3);
  element.style.visibility = opacity <= 0.001 ? 'hidden' : 'visible';
  if (transform) element.style.transform = transform;
};

// Bloco de texto: linhas sobem por trás de uma máscara, olho e subtítulo aparecem em seguida.
function copy(block: HTMLElement, t: number, start: number, end: number) {
  const active = t > start - 0.05 && t < end + 0.7;
  block.style.visibility = active ? 'visible' : 'hidden';
  if (!active) return;
  all('.l > span', block).forEach((line, index) => {
    const enter = outExpo(range(t, start + index * 0.1, start + index * 0.1 + 0.95));
    const leave = inCubic(range(t, end - 0.45 + index * 0.06, end + index * 0.06));
    line.style.transform = `translateY(${((1 - enter) * 112 - leave * 112).toFixed(2)}%)`;
  });
  const meta = outCubic(range(t, start + 0.25, start + 0.9)) * (1 - range(t, end - 0.45, end));
  for (const element of all('.eyebrow, .sub', block)) show(element, meta, `translateY(${((1 - meta) * 18).toFixed(1)}px)`);
}

// Ruído de filme determinístico.
function grainTile() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(256, 256);
  let seed = 7;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < image.data.length; i += 4) {
    const value = Math.round(random() * 255);
    image.data[i] = value; image.data[i + 1] = value; image.data[i + 2] = value; image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

// Posição do brilho de fundo ao longo do vídeo.
const GLOW: Array<[number, number, number]> = [
  [0, 960, 540], [4, 960, 540], [5, 1240, 560], [12.4, 1240, 560], [13.4, 960, 760], [20.2, 960, 760],
  [21, 1300, 560], [28.4, 1300, 560], [29.2, 1420, 620], [36.6, 1420, 620], [37.4, 960, 660], [41.4, 960, 660], [42.2, 960, 520], [45, 960, 520],
];
function glowAt(t: number): [number, number] {
  for (let i = 1; i < GLOW.length; i += 1) {
    const [t1, x1, y1] = GLOW[i];
    const [t0, x0, y0] = GLOW[i - 1];
    if (t <= t1) { const k = inOut(range(t, t0, t1)); return [lerp(x0, x1, k), lerp(y0, y1, k)]; }
  }
  return [960, 520];
}

function setup() {
  const stage = one('#stage');
  const glow = one('#glow');
  const grain = one('#grain');
  // Textura fixa: dá o grão de filme sem pesar no vídeo (ruído que muda a cada quadro não comprime).
  grain.style.backgroundImage = `url(${grainTile()})`;
  const fade = one('#fade');
  const barTop = one('#bar-top');
  const barBottom = one('#bar-bottom');

  // 1 · Marca
  const sLogo = one('#s-logo');
  const lockup = one('.lockup', sLogo);
  const leaf = one<SVGGElement>('#leaf', sLogo);
  leaf.style.transformBox = 'fill-box';
  leaf.style.transformOrigin = '0% 100%';
  const veins = all<SVGPathElement>('.vein', sLogo);
  const nodes = all<SVGRectElement>('.node', sLogo);
  const seedGrain = one<SVGGElement>('.grain-seed', sLogo);
  const wordmark = one('#wordmark', sLogo);
  const dot = one('.dot', wordmark);
  const tagline = one('#tagline', sLogo);

  // 2 · Globo
  const sGlobe = one('#s-globe');
  const globeCanvas = one<HTMLCanvasElement>('#globe');
  const drawGlobe = createGlobe(globeCanvas, WIDTH, HEIGHT);
  const globeNote = one('#globe-note', sGlobe);

  // 3 · Campo
  const sField = one('#s-field');
  const farm = one('#farm', sField);
  const hq = one('#hq', sField);
  const queue = one('#queue', sField);
  const queueCells = Array.from({ length: 24 }, () => queue.appendChild(document.createElement('i')));
  const queueCount = one('#queue-count', sField);
  const packets = one('#packets', sField);
  const packetEls = Array.from({ length: 10 }, () => { const el = packets.appendChild(document.createElement('div')); el.className = 'packet'; return el; });
  const linkOk = one<SVGLineElement>('#link-ok', sField);
  const linkBad = one<SVGLineElement>('#link-bad', sField);
  const labelOk = one('#label-ok', sField);
  const labelBad = one('#label-bad', sField);
  const labelFlush = one('#label-flush', sField);
  const hqPill = one('#hq-pill', sField);
  const hqTimer = one('#hq-timer', sField);
  const hqFast = one('#hq-fast', sField);
  const toastBad = one('#toast-bad', sField);
  const toastGood = one('#toast-good', sField);

  // 4 · Painel
  const sPanel = one('#s-panel');
  const device = one('#device', sPanel);
  const shotB = one('#shot-b', sPanel);
  const rings = ['a', 'b', 'c', 'd', 'e'].map((id) => one(`#ring-${id}`, sPanel));
  const panelDemo = one('.demo', sPanel);

  // 5 · Monitoramento
  const sMon = one('#s-mon');
  const invHead = one('#inv-head', sMon);
  const families = all('.fam', sMon);
  const zbx = one('#zbx', sMon);
  const gfn = one('#gfn', sMon);
  const zbxHosts = one('#zbx-hosts', sMon);
  const zbxApi = one('#zbx-api', sMon);
  const templates = all('.tpl .chip', sMon);
  const monDemo = one('.demo', sMon);
  const svg = one<SVGSVGElement>('#mon-links', sMon);
  const routes: SVGPathElement[] = [];
  families.forEach((_, index) => {
    const y = 592 + index * 90 + 38;
    for (const [tx, ty] of [[1120, 400], [1120, 780]]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M640 ${y} C 860 ${y}, 900 ${ty}, ${tx} ${ty}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#2f6b3a');
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('pathLength', '1');
      path.style.strokeDasharray = '1';
      svg.appendChild(path);
      routes.push(path);
    }
  });
  const routeLengths = routes.map((path) => path.getTotalLength());
  const flows = one('#flows', sMon);
  const flowEls = routes.flatMap(() => [0, 1].map(() => { const el = flows.appendChild(document.createElement('div')); el.className = 'flow'; return el; }));
  const panelsBox = one('#gfn-panels', sMon);
  const minis = ['Núcleo', 'Wi-Fi', 'Campo', 'Segurança'].map((label) => {
    const mini = panelsBox.appendChild(document.createElement('div'));
    mini.className = 'mini';
    mini.innerHTML = `<span>${label}</span><div class="bars"></div>`;
    const bars = one('.bars', mini);
    return { mini, bars: Array.from({ length: 14 }, () => bars.appendChild(document.createElement('i'))) };
  });

  // 6 · Acesso
  const sLogin = one('#s-login');
  const providers = all('.provider', sLogin);
  const guards = all('.guard', sLogin);

  // 7 · Final
  const sEnd = one('#s-end');
  const endLockup = one('.lockup', sEnd);
  const claim = one('.claim', sEnd);
  const endChips = all('.chips .chip', sEnd);
  const url = one('.url', sEnd);

  const timeText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

  function seek(time: number) {
    const t = clamp(time, 0, DURATION);

    // Moldura: barras de cinema abrem no início e fecham no fim; ruído e brilho acompanham.
    const open = outExpo(range(t, 0.15, 1.3)) * (1 - inOut(range(t, 44.1, 45)));
    const bar = lerp(540, 72, open);
    barTop.style.height = `${bar}px`;
    barBottom.style.height = `${bar}px`;
    fade.style.opacity = (1 - range(t, 0, 0.5) + range(t, 44.5, 45)).toFixed(3);
    const [gx, gy] = glowAt(t);
    glow.style.left = `${gx}px`;
    glow.style.top = `${gy}px`;

    // 1 · Marca (0 – 4,4 s)
    const logoOn = t < 4.5;
    show(sLogo, logoOn ? 1 - outCubic(range(t, 3.7, 4.4)) : 0);
    if (logoOn) {
      const grow = range(t, 0.4, 1.4);
      leaf.style.opacity = outCubic(range(t, 0.4, 0.9)).toFixed(3);
      leaf.style.transform = `scale(${lerp(0.5, 1, outBack(grow)).toFixed(4)}) rotate(${lerp(-28, 0, outExpo(grow)).toFixed(2)}deg)`;
      veins.forEach((vein, index) => { vein.style.strokeDashoffset = (1 - outCubic(range(t, 1.0 + index * 0.16, 1.6 + index * 0.16))).toFixed(4); });
      nodes.forEach((node, index) => { node.style.transform = `scale(${outBack(range(t, 1.45 + index * 0.12, 1.85 + index * 0.12)).toFixed(4)})`; });
      seedGrain.style.transform = `scale(${outBack(range(t, 1.8, 2.25)).toFixed(4)})`;
      const word = outExpo(range(t, 1.9, 2.9));
      wordmark.style.transform = `translateY(${((1 - word) * 105).toFixed(2)}%)`;
      wordmark.style.opacity = outCubic(range(t, 1.9, 2.3)).toFixed(3);
      dot.style.transform = `scale(${outBack(range(t, 2.55, 2.95)).toFixed(4)})`;
      show(tagline, outCubic(range(t, 2.6, 3.3)), `translateY(${((1 - outCubic(range(t, 2.6, 3.3))) * 24).toFixed(1)}px)`);
      lockup.style.transform = `translate(-50%, -58%) scale(${lerp(1.04, 1, outCubic(range(t, 0.4, 3.6))) * lerp(1, 0.9, inCubic(range(t, 3.6, 4.4)))})`;
    }

    // 2 · Globo e Mato Grosso (3,6 – 12,8 s)
    const globeOn = t > 3.5 && t < 12.9;
    show(sGlobe, globeOn ? 1 : 0);
    const globeAlpha = globeOn ? outCubic(range(t, 3.6, 4.8)) * (1 - range(t, 12.0, 12.8)) : 0;
    globeCanvas.style.opacity = globeAlpha.toFixed(3);
    if (globeAlpha > 0) {
      const spin = wrap(-110 + 8.5 * (t - 3.6));
      const k = inOut(range(t, 6.9, 10.3));
      const turn = inOut(clamp(k * 1.7));
      const dive = inOut(clamp(k * 1.35 - 0.35));
      const view: View = {
        center: spin + wrap(MT_VIEW.lon - spin) * turn,
        tilt: 14 + (MT_VIEW.lat - 14) * turn,
        zoom: MT_VIEW.zoom ** dive * lerp(1, 1.06, range(t, 10.3, 12.8)),
        local: dive,
      };
      drawGlobe(view, t, lerp(1250, 1230, dive), 560, 430);
    }
    if (globeOn) {
      copy(one('[data-copy="a"]', sGlobe), t, 4.3, 7.4);
      copy(one('[data-copy="b"]', sGlobe), t, 9.9, 12.5);
      show(globeNote, life(t, 10.2, 12.5));
    }

    // 3 · Coleta: queda e recuperação (12,4 – 20,6 s)
    const fieldOn = t > 12.1 && t < 20.7;
    show(sField, fieldOn ? outCubic(range(t, 12.2, 12.8)) * (1 - range(t, 20.0, 20.6)) : 0,
      `scale(${lerp(1.04, 1, outCubic(range(t, 12.2, 20.6))).toFixed(4)})`);
    if (fieldOn) {
      copy(one('[data-copy="a"]', sField), t, 12.7, 14.9);
      copy(one('[data-copy="b"]', sField), t, 15.0, 17.9);
      copy(one('[data-copy="c"]', sField), t, 18.0, 20.4);
      const cardIn = (delay: number) => outExpo(range(t, 12.7 + delay, 13.7 + delay));
      show(farm, cardIn(0), `translateY(${((1 - cardIn(0)) * 70).toFixed(1)}px)`);
      show(hq, cardIn(0.15), `translateY(${((1 - cardIn(0.15)) * 70).toFixed(1)}px)`);
      const down = t >= 14.7 && t < 17.9;
      const online = life(t, 13.1, 14.8, 0.4, 0.2) + life(t, 17.9, 21, 0.3, 0.1);
      linkOk.style.opacity = clamp(online).toFixed(3);
      linkOk.style.strokeDashoffset = (-t * 60).toFixed(1);
      linkBad.style.opacity = life(t, 14.7, 18.0, 0.15, 0.2).toFixed(3);
      show(labelOk, life(t, 13.3, 14.7, 0.4, 0.2) + life(t, 19.5, 21, 0.4, 0.1));
      show(labelBad, life(t, 14.8, 17.9, 0.3, 0.2));
      show(labelFlush, life(t, 18.0, 19.5, 0.3, 0.3));
      packetEls.forEach((el, index) => {
        let position = -1;
        let alpha = 0;
        if (index < 3 && t > 13.2 && t < 14.8) {
          position = (t * 0.55 + index / 3) % 1;
          alpha = life(t, 13.2, 14.8, 0.3, 0.15);
        } else if (t > 18.1 && t < 19.9) {
          position = range(t, 18.1 + index * 0.12, 18.65 + index * 0.12);
          alpha = position > 0 && position < 1 ? 1 : 0;
        }
        show(el, alpha * Math.sin(Math.PI * clamp(position)) ** 0.3);
        if (alpha > 0) { el.style.left = `${lerp(720, 1200, position)}px`; el.style.top = '715px'; }
      });
      const queued = t < 14.9 ? 0 : t < 18.1 ? Math.floor(24 * range(t, 14.9, 17.6)) : Math.ceil(24 * (1 - range(t, 18.1, 19.3)));
      queueCount.textContent = String(queued);
      queueCount.style.color = queued ? 'var(--warn)' : 'var(--text)';
      queueCells.forEach((cell, index) => cell.classList.toggle('on', index < queued));
      const silent = t >= 16.6 && t < 18.3;
      hqPill.className = `pill ${silent ? 'bad' : 'ok'}`;
      hqPill.textContent = silent ? '● Sem contato' : '● Em contato';
      const since = down ? (t < 16.6 ? lerp(0, 180, range(t, 14.7, 16.6)) : lerp(180, 232, range(t, 16.6, 17.9))) : (t * 9) % 40;
      hqTimer.textContent = timeText(since);
      hqTimer.style.color = since >= 180 && down ? 'var(--danger)' : 'var(--text)';
      show(hqFast, life(t, 14.8, 17.9, 0.3, 0.2));
      const bad = life(t, 16.6, 18.3, 0.35, 0.3);
      show(toastBad, bad, `translateY(${((1 - outBack(range(t, 16.6, 17.0))) * 26).toFixed(1)}px)`);
      const good = outCubic(range(t, 18.5, 19.0));
      show(toastGood, good, `translateY(${((1 - outBack(range(t, 18.5, 18.9))) * 26).toFixed(1)}px)`);
    }

    // 4 · Painel (20,2 – 28,6 s)
    const panelOn = t > 20.1 && t < 28.7;
    show(sPanel, panelOn ? outCubic(range(t, 20.2, 20.8)) * (1 - range(t, 28.0, 28.6)) : 0);
    if (panelOn) {
      copy(one('[data-copy="a"]', sPanel), t, 20.6, 24.3);
      copy(one('[data-copy="b"]', sPanel), t, 24.4, 28.3);
      const enter = outExpo(range(t, 20.3, 21.9));
      const drift = range(t, 20.3, 28.6);
      device.style.transform = `translateX(${lerp(160, 0, enter).toFixed(1)}px) rotateY(${(lerp(-24, -7, enter) + drift * 4).toFixed(2)}deg) rotateX(${lerp(9, 3, enter).toFixed(2)}deg) scale(${(lerp(0.9, 1, enter) * lerp(1, 1.035, drift)).toFixed(4)})`;
      device.style.opacity = outCubic(range(t, 20.3, 20.9)).toFixed(3);
      shotB.style.opacity = outCubic(range(t, 24.2, 24.8)).toFixed(3);
      const ringWindows: Array<[number, number]> = [[21.5, 22.8], [22.6, 23.7], [23.5, 24.3], [25.3, 26.6], [26.4, 27.8]];
      rings.forEach((ring, index) => {
        const [a, b] = ringWindows[index];
        const k = outBack(range(t, a, a + 0.45));
        show(ring, life(t, a, b, 0.25, 0.3), `scale(${lerp(1.08, 1, k).toFixed(4)})`);
      });
      show(panelDemo, life(t, 21.2, 28.3));
    }

    // 5 · Monitoramento (28,4 – 36,6 s)
    const monOn = t > 28.3 && t < 36.7;
    show(sMon, monOn ? outCubic(range(t, 28.4, 29.0)) * (1 - range(t, 36.0, 36.6)) : 0);
    if (monOn) {
      copy(one('[data-copy="a"]', sMon), t, 28.8, 36.3);
      show(invHead, outCubic(range(t, 29.0, 29.5)));
      families.forEach((row, index) => {
        const k = outExpo(range(t, 29.3 + index * 0.22, 30.1 + index * 0.22));
        show(row, k, `translateX(${((1 - k) * -50).toFixed(1)}px)`);
      });
      const cardIn = (delay: number) => outExpo(range(t, 29.4 + delay, 30.4 + delay));
      show(zbx, cardIn(0), `translateY(${((1 - cardIn(0)) * 50).toFixed(1)}px)`);
      show(gfn, cardIn(0.2), `translateY(${((1 - cardIn(0.2)) * 50).toFixed(1)}px)`);
      routes.forEach((path, index) => { path.style.strokeDashoffset = (1 - outCubic(range(t, 30.3 + (index >> 1) * 0.12, 31.2 + (index >> 1) * 0.12))).toFixed(4); });
      flowEls.forEach((el, index) => {
        const route = index >> 1;
        const position = (t * 0.42 + (index % 2) * 0.5 + route * 0.13) % 1;
        const alpha = life(t, 31.0 + (route >> 1) * 0.1, 36.0, 0.4, 0.3);
        show(el, alpha * Math.sin(Math.PI * position));
        if (alpha > 0) {
          const point = routes[route].getPointAtLength(position * routeLengths[route]);
          el.style.left = `${point.x}px`;
          el.style.top = `${point.y}px`;
        }
      });
      zbxHosts.textContent = String(Math.round(6 * outCubic(range(t, 31.0, 33.0))));
      templates.forEach((chip, index) => { const k = outBack(range(t, 31.2 + index * 0.25, 31.6 + index * 0.25)); show(chip, clamp(k), `scale(${lerp(0.8, 1, k).toFixed(4)})`); });
      show(zbxApi, outCubic(range(t, 33.6, 34.1)));
      minis.forEach(({ mini, bars }, column) => {
        const appear = outCubic(range(t, 31.6 + column * 0.2, 32.4 + column * 0.2));
        show(mini, appear);
        bars.forEach((barEl, index) => {
          const wave = 0.5 + 0.5 * Math.sin(index * 0.9 + column * 1.7 + t * 2.1) * Math.cos(index * 0.37 + t * 0.8);
          barEl.style.height = `${((18 + wave * 82) * appear).toFixed(1)}%`;
          barEl.style.background = column === 3 ? 'var(--wheat)' : 'var(--leaf)';
        });
      });
      show(monDemo, life(t, 30.0, 36.2));
    }

    // 6 · Acesso e segurança (36,6 – 41,6 s)
    const loginOn = t > 36.5 && t < 41.7;
    show(sLogin, loginOn ? outCubic(range(t, 36.6, 37.2)) * (1 - range(t, 41.0, 41.6)) : 0);
    if (loginOn) {
      copy(one('[data-copy="a"]', sLogin), t, 36.9, 39.0);
      copy(one('[data-copy="b"]', sLogin), t, 39.1, 41.4);
      providers.forEach((card, index) => {
        const k = outExpo(range(t, 37.3 + index * 0.18, 38.3 + index * 0.18));
        show(card, k, `translateY(${((1 - k) * 60).toFixed(1)}px)`);
      });
      guards.forEach((guard, index) => {
        const k = outExpo(range(t, 39.4 + index * 0.22, 40.2 + index * 0.22));
        show(guard, k, `translateY(${((1 - k) * 30).toFixed(1)}px)`);
      });
    }

    // 7 · Final (41,4 – 45 s)
    const endOn = t > 41.3;
    show(sEnd, endOn ? outCubic(range(t, 41.4, 42.0)) : 0);
    if (endOn) {
      const k = outBack(range(t, 41.5, 42.4));
      endLockup.style.transform = `translateX(-50%) scale(${lerp(0.86, 1, k).toFixed(4)})`;
      const c = outExpo(range(t, 42.0, 42.9));
      show(claim, c, `translateY(${((1 - c) * 40).toFixed(1)}px)`);
      endChips.forEach((chip, index) => { const kk = outBack(range(t, 42.4 + index * 0.1, 42.8 + index * 0.1)); show(chip, clamp(kk), `scale(${lerp(0.8, 1, kk).toFixed(4)})`); });
      show(url, outCubic(range(t, 42.9, 43.5)));
    }
    stage.dataset.t = t.toFixed(3);
  }

  const images = all<HTMLImageElement>('img');
  const ready = Promise.all([document.fonts.ready, ...images.map((image) => image.decode().catch(() => undefined))]).then(() => undefined);
  window.malhaVideo = { duration: DURATION, seek, ready };

  if (!new URLSearchParams(location.search).has('render')) {
    // Pré-visualização: toca em loop no navegador.
    const start = performance.now();
    const loop = (now: number) => { seek(((now - start) / 1000) % DURATION); requestAnimationFrame(loop); };
    ready.then(() => requestAnimationFrame(loop));
  } else {
    seek(0);
  }
}

setup();
