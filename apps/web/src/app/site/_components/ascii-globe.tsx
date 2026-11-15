'use client';

import { Pause, Play } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import styles from '../site.module.css';
import { isLand, landMask } from './land-mask';
import { MT_OUTLINE, NEIGHBOR_OUTLINES } from './mt-outline';

interface Place { code: string; lat: number; lon: number }
interface Farm { label: string; short: string; lat: number; lon: number; status: 'online' | 'silent' | 'none'; side: 1 | -1; dy: number }

// Ilustração: rotas de exemplo entre Mato Grosso e polos do agronegócio. Não representa dados do produto.
const HUB: Place = { code: 'MT·BRA', lat: -12.55, lon: -55.71 };
const PLACES: Place[] = [
  { code: 'CHN', lat: 31.23, lon: 121.47 },
  { code: 'NLD', lat: 51.92, lon: 4.48 },
  { code: 'USA', lat: 41.88, lon: -87.63 },
  { code: 'SGP', lat: 1.35, lon: 103.82 },
  { code: 'ARE', lat: 25.2, lon: 55.27 },
  { code: 'ARG', lat: -34.6, lon: -58.38 },
  { code: 'NGA', lat: 6.52, lon: 3.38 },
  { code: 'JPN', lat: 35.68, lon: 139.69 },
  { code: 'MEX', lat: 19.43, lon: -99.13 },
  { code: 'IND', lat: 19.07, lon: 72.87 },
  { code: 'ESP', lat: 40.42, lon: -3.7 },
];
const ROUTES: Array<[Place, Place]> = [
  ...PLACES.map((place): [Place, Place] => [HUB, place]),
  [PLACES[1], PLACES[2]],
  [PLACES[4], PLACES[3]],
  [PLACES[3], PLACES[7]],
  [PLACES[0], PLACES[7]],
  [PLACES[8], PLACES[2]],
  [PLACES[10], PLACES[6]],
  [PLACES[9], PLACES[4]],
];

// Fazendas de exemplo com o mesmo estado do demo do painel: Vale Verde em contato,
// Santa Luzia com o coletor sem contato e Horizonte ainda sem coletor.
const MATRIZ = { label: 'Matriz · Cuiabá', short: 'Matriz', lat: -15.6, lon: -56.1 };
const FARMS: Farm[] = [
  { label: 'Faz. Horizonte · sem coletor', short: 'Horizonte', lat: -12.55, lon: -55.71, status: 'none', side: 1, dy: 16 },
  { label: 'Faz. Vale Verde · em contato', short: 'Vale Verde', lat: -11.86, lon: -55.5, status: 'online', side: 1, dy: -10 },
  { label: 'Faz. Santa Luzia · sem contato', short: 'Santa Luzia', lat: -11.25, lon: -57.52, status: 'silent', side: -1, dy: -10 },
];
const FARM_COLORS = { online: '200 255 170', silent: '241 180 91', none: '150 170 155' } as const;
const STATES: Array<[string, number, number]> = [
  ['MATO GROSSO', -16.9, -54.3], ['RO', -10.9, -62.6], ['PA', -6.4, -53.5], ['TO', -10.4, -48.4],
  ['GO', -15.9, -50.2], ['MS', -19.6, -54.6], ['BOLÍVIA', -16.2, -62.2],
];

const LAND_RAMP = '.:-=+*#%@';
const PARCELS = '=-+:;=%-';
const RAD = Math.PI / 180;
const LIGHT = normalize([-0.55, 0.55, 0.63]);
const ROUTE_CYCLE = 7.5;
const GLOBAL_TILT = 14;
const MT_VIEW = { lat: -12.9, lon: -55.9, zoom: 8 };
// Linha do tempo do loop, em segundos: globo, aproximação, Mato Grosso, afastamento.
const CYCLE = 22;
const ZOOM_IN: [number, number] = [2.5, 6];
const ZOOM_OUT: [number, number] = [16, 19.5];
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

function normalize([x, y, z]: number[]) {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}
function clamp(value: number, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function ease(t: number) { return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; }
function wrap(angle: number) { return ((angle + 540) % 360) - 180; }
function hash(x: number, y: number) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function toVector(lat: number, lon: number) {
  const phi = lat * RAD;
  const lambda = lon * RAD;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

// Interpolação esférica entre dois pontos, com o arco elevado acima da superfície.
function arcPoint(a: number[], b: number[], t: number, lift: number) {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  const sin = Math.sin(omega) || 1;
  const wa = Math.sin((1 - t) * omega) / sin;
  const wb = Math.sin(t * omega) / sin;
  const h = 1 + lift * Math.sin(Math.PI * t);
  const p = [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
  const lat = Math.asin(p[2] / Math.hypot(p[0], p[1], p[2])) / RAD;
  const lon = Math.atan2(p[1], p[0]) / RAD;
  return { lat, lon, h };
}

interface View { center: number; tilt: number; zoom: number; local: number }

// Projeção ortográfica centrada em (tilt, center). Retorna coordenadas na esfera unitária.
function project(lat: number, lon: number, view: View, h = 1) {
  const phi = lat * RAD;
  const tilt = view.tilt * RAD;
  const dl = (lon - view.center) * RAD;
  const x = Math.cos(phi) * Math.sin(dl);
  const y = Math.cos(tilt) * Math.sin(phi) - Math.sin(tilt) * Math.cos(phi) * Math.cos(dl);
  const z = Math.sin(tilt) * Math.sin(phi) + Math.cos(tilt) * Math.cos(phi) * Math.cos(dl);
  return { x: x * h, y: y * h, z: z * h, visible: z > 0 || (x * x + y * y) * h * h > 1 };
}

function unproject(x: number, y: number, view: View) {
  const rho = Math.hypot(x, y);
  const tilt = view.tilt * RAD;
  if (rho === 0) return { lat: view.tilt, lon: view.center };
  const c = Math.asin(Math.min(1, rho));
  const lat = Math.asin(Math.cos(c) * Math.sin(tilt) + (y * Math.sin(c) * Math.cos(tilt)) / rho);
  const lon = view.center * RAD + Math.atan2(x * Math.sin(c), rho * Math.cos(c) * Math.cos(tilt) - y * Math.sin(c) * Math.sin(tilt));
  return { lat: lat / RAD, lon: wrap(lon / RAD) };
}

// Raster de Mato Grosso a 0,05° para consulta rápida por célula.
const MT_BOX = { west: -62, east: -50, south: -18.5, north: -7, step: 0.08 };
function rasterizeMt() {
  const cols = Math.round((MT_BOX.east - MT_BOX.west) / MT_BOX.step);
  const rows = Math.round((MT_BOX.north - MT_BOX.south) / MT_BOX.step);
  const grid = new Uint8Array(cols * rows);
  const n = MT_OUTLINE.length / 2;
  for (let row = 0; row < rows; row += 1) {
    const lat = MT_BOX.north - (row + 0.5) * MT_BOX.step;
    for (let col = 0; col < cols; col += 1) {
      const lon = MT_BOX.west + (col + 0.5) * MT_BOX.step;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
        const xi = MT_OUTLINE[i * 2], yi = MT_OUTLINE[i * 2 + 1];
        const xj = MT_OUTLINE[j * 2], yj = MT_OUTLINE[j * 2 + 1];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      grid[row * cols + col] = inside ? 1 : 0;
    }
  }
  return (lat: number, lon: number) => {
    if (lon < MT_BOX.west || lon >= MT_BOX.east || lat <= MT_BOX.south || lat > MT_BOX.north) return false;
    const col = Math.floor((lon - MT_BOX.west) / MT_BOX.step);
    const row = Math.floor((MT_BOX.north - lat) / MT_BOX.step);
    return grid[row * cols + col] === 1;
  };
}

type Scene = 'full' | 'world';

function viewAt(seconds: number, spin: number, reduced: boolean, scene: Scene): View {
  // Movimento reduzido: um quadro fixo. No site é Mato Grosso com as fazendas; no portal, o planeta.
  if (reduced) return scene === 'world' ? { center: -50, tilt: 4, zoom: 1, local: 0 } : { center: MT_VIEW.lon, tilt: MT_VIEW.lat, zoom: MT_VIEW.zoom, local: 1 };
  if (scene === 'world') return { center: spin, tilt: GLOBAL_TILT, zoom: 1, local: 0 };
  const t = seconds % CYCLE;
  const k = t < ZOOM_IN[0] ? 0
    : t < ZOOM_IN[1] ? (t - ZOOM_IN[0]) / (ZOOM_IN[1] - ZOOM_IN[0])
      : t < ZOOM_OUT[0] ? 1
        : t < ZOOM_OUT[1] ? 1 - (t - ZOOM_OUT[0]) / (ZOOM_OUT[1] - ZOOM_OUT[0]) : 0;
  // Primeiro gira até Mato Grosso, depois aproxima.
  const turn = ease(clamp(k * 1.7));
  const dive = ease(clamp(k * 1.35 - 0.35));
  return {
    center: spin + wrap(MT_VIEW.lon - spin) * turn,
    tilt: GLOBAL_TILT + (MT_VIEW.lat - GLOBAL_TILT) * turn,
    zoom: MT_VIEW.zoom ** dive,
    local: dive,
  };
}

// Com `paused` informado, quem renderiza controla a pausa e o botão; sem ele, o globo traz o próprio botão.
export function AsciiGlobe({ className, scene = 'full', paused: controlled }: { className?: string; scene?: Scene; paused?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const [own, setPaused] = useState(false);
  const paused = controlled ?? own;
  const pausedRef = useRef(false);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const mask = landMask();
    // O raster sai do carregamento inicial: fica pronto no primeiro momento ocioso, bem antes do zoom.
    let inMt: (lat: number, lon: number) => boolean = () => false;
    const schedule = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 200));
    const cancelSchedule = window.cancelIdleCallback ?? window.clearTimeout;
    const rasterTask = schedule(() => { inMt = rasterizeMt(); if (reduced) draw(0); });
    const vectors = new Map<Place | Farm | typeof MATRIZ, number[]>();
    for (const place of [HUB, ...PLACES, ...FARMS, MATRIZ]) vectors.set(place, toVector(place.lat, place.lon));

    let width = 0;
    let height = 0;
    let cellW = 7;
    let cellH = 13;
    let fontSize = 12;
    let frame = 0;
    let last = 0;
    let visible = true;
    let spin = -42;
    let velocity = 0;
    let dragging: { x: number; spin: number } | null = null;

    function resize() {
      // Tamanho de layout: ignora as escalas aplicadas pela animação de entrada e pela câmera.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      canvas!.width = Math.round(width * ratio);
      canvas!.height = Math.round(height * ratio);
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      fontSize = width < 420 ? 9 : width < 640 ? 10.5 : 12;
      context!.font = `500 ${fontSize}px ${MONO}`;
      cellW = context!.measureText('M').width;
      cellH = Math.round(fontSize * 1.18);
    }

    function draw(seconds: number) {
      const ctx = context!;
      const view = viewAt(seconds, spin, Boolean(reduced), scene);
      const narrow = width < 480;
      const local = view.local;
      const global = 1 - local;
      ctx.clearRect(0, 0, width, height);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.font = `500 ${fontSize}px ${MONO}`;
      const base = Math.min(width, height) * 0.45;
      const radius = base * view.zoom;
      const cx = width / 2;
      const cy = height / 2;
      const cols = Math.ceil(width / cellW);
      const rows = Math.ceil(height / cellH);
      const colOf = (px: number) => Math.floor(px / cellW);
      const rowOf = (py: number) => Math.floor(py / cellH);
      const cellX = (col: number) => col * cellW + cellW / 2;
      const cellY = (row: number) => row * cellH + cellH / 2;
      const screen = (lat: number, lon: number, h = 1) => {
        const p = project(lat, lon, view, h);
        return { ...p, sx: cx + p.x * radius, sy: cy - p.y * radius };
      };
      const detailed = view.zoom > 3;
      const gridStep = detailed ? 2 : 20;

      const buckets = new Map<string, Array<[number, number, string]>>();
      const put = (color: string, col: number, row: number, char: string) => {
        let list = buckets.get(color);
        if (!list) buckets.set(color, list = []);
        list.push([col, row, char]);
      };

      for (let row = 0; row < rows; row += 1) {
        const ny = (cy - cellY(row)) / radius;
        if (Math.abs(ny) > 1.08) continue;
        for (let col = 0; col < cols; col += 1) {
          const nx = (cellX(col) - cx) / radius;
          const rr = nx * nx + ny * ny;
          if (rr > 1) {
            if (rr < 1.1 && (col + row) % 2 === 0 && view.zoom < 1.6) put('rgb(120 220 140 / 0.16)', col, row, '.');
            continue;
          }
          const nz = Math.sqrt(1 - rr);
          const light = detailed ? 0.8 : Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
          const { lat, lon } = unproject(nx, ny, view);
          const mt = inMt(lat, lon);
          if (mt && detailed) {
            // Lavouras em parcelas: cada talhão recebe um padrão e uma cor.
            const px = Math.floor(lon / 0.42);
            const py = Math.floor(lat / 0.3);
            const h = hash(px, py);
            const char = PARCELS[Math.floor(h * PARCELS.length)];
            const wheat = h > 0.62;
            const alpha = (0.45 + hash(px + 7, py) * 0.4).toFixed(2);
            put(wheat ? `rgb(217 184 102 / ${alpha})` : `rgb(150 220 120 / ${alpha})`, col, row, char);
          } else if (mt || isLand(mask, lat, lon)) {
            if (detailed) {
              if (hash(col, row) > 0.7) put('rgb(110 150 115 / 0.22)', col, row, '.');
              continue;
            }
            const shade = Math.min(1, 0.18 + light * 0.9);
            const level = Math.round(shade * 6) / 6;
            const char = LAND_RAMP[Math.min(LAND_RAMP.length - 1, Math.floor(shade * LAND_RAMP.length))];
            if (mt) put(`rgb(${Math.round(150 + level * 80)} ${Math.round(120 + level * 70)} ${Math.round(60 + level * 40)})`, col, row, char);
            else put(`rgb(${Math.round(40 + level * 150)} ${Math.round(90 + level * 152)} ${Math.round(50 + level * 70)})`, col, row, char);
          } else {
            const threshold = detailed ? 0.06 : 0.9;
            const latLine = Math.abs(((lat % gridStep) + gridStep) % gridStep) < threshold;
            const lonLine = Math.abs(((lon % gridStep) + gridStep) % gridStep) < threshold / Math.max(0.2, Math.cos(lat * RAD));
            if (latLine || lonLine) put(`rgb(110 200 130 / ${(0.1 + light * 0.22).toFixed(2)})`, col, row, '·');
            else if (((col * 7 + row * 13) ^ (row * 5)) % 9 === 0) put(`rgb(80 150 100 / ${(0.04 + light * 0.1).toFixed(2)})`, col, row, '.');
          }
        }
      }

      const overlay = new Map<string, [number, number, string, string]>();
      const mark = (col: number, row: number, char: string, color: string) => overlay.set(`${col}:${row}`, [col, row, char, color]);

      // Contornos: Mato Grosso em trigo, vizinhos pontilhados na aproximação.
      const trace = (outline: readonly number[], char: string, color: string, spacing: number) => {
        const n = outline.length / 2;
        for (let i = 0; i < n; i += 1) {
          const j = (i + 1) % n;
          const a = screen(outline[i * 2 + 1], outline[i * 2]);
          const b = screen(outline[j * 2 + 1], outline[j * 2]);
          if (a.z <= 0 && b.z <= 0) continue;
          const steps = Math.max(1, Math.ceil(Math.hypot(b.sx - a.sx, b.sy - a.sy) / spacing));
          for (let s = 0; s < steps; s += 1) {
            const x = a.sx + ((b.sx - a.sx) * s) / steps;
            const y = a.sy + ((b.sy - a.sy) * s) / steps;
            if (x < 0 || y < 0 || x > width || y > height) continue;
            mark(colOf(x), rowOf(y), char, color);
          }
        }
      };
      if (local > 0.15) {
        const alpha = clamp((local - 0.15) / 0.5);
        for (const outline of NEIGHBOR_OUTLINES) trace(outline, '·', `rgb(150 200 150 / ${(alpha * 0.45).toFixed(2)})`, cellW * 1.6);
      }
      trace(MT_OUTLINE, detailed ? '•' : '·', `rgb(236 217 164 / ${(0.45 + local * 0.5).toFixed(2)})`, cellW * 0.9);

      // Rotas entre países, que somem durante a aproximação.
      if (global > 0.02) {
        ROUTES.forEach(([from, to], index) => {
          const a = vectors.get(from)!;
          const b = vectors.get(to)!;
          const distance = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
          const lift = 0.08 + distance * 0.09;
          const phase = reduced ? 0.7 : ((seconds / ROUTE_CYCLE + index * 0.37) % 1.6);
          const head = Math.min(1, phase * 1.4);
          const tail = Math.max(0, (phase - 0.75) * 1.6);
          if (tail >= head) return;
          const steps = Math.max(10, Math.round(distance * 34 * view.zoom));
          for (let step = 0; step <= steps; step += 1) {
            const t = tail + ((head - tail) * step) / steps;
            const point = arcPoint(a, b, t, lift);
            const p = screen(point.lat, point.lon, point.h);
            if (!p.visible || p.sx < 0 || p.sy < 0 || p.sx > width || p.sy > height) continue;
            const nearHead = (head - t) < 0.04 && head < 1;
            const progress = (t - tail) / Math.max(0.001, head - tail);
            const alpha = (nearHead ? 1 : 0.6 + 0.4 * progress) * global;
            mark(colOf(p.sx), rowOf(p.sy), nearHead ? '●' : progress > 0.55 ? '•' : '·',
              nearHead ? `rgb(244 255 230 / ${global.toFixed(2)})` : `rgb(200 255 140 / ${alpha.toFixed(2)})`);
          }
        });
      }

      // Enlaces das fazendas até a matriz: pacotes contínuos; Santa Luzia aparece cortada.
      if (local > 0.55) {
        const alpha = clamp((local - 0.55) / 0.35);
        const target = vectors.get(MATRIZ)!;
        FARMS.forEach((farm, index) => {
          const source = vectors.get(farm)!;
          const steps = 40;
          for (let step = 0; step <= steps; step += 1) {
            const t = step / steps;
            const point = arcPoint(source, target, t, 0.004);
            const p = screen(point.lat, point.lon, point.h);
            const col = colOf(p.sx);
            const row = rowOf(p.sy);
            if (farm.status === 'none') continue;
            if (farm.status === 'silent') {
              if (t > 0.42 && t < 0.58) { if (Math.abs(t - 0.5) < 0.02) mark(col, row, '×', `rgb(241 180 91 / ${alpha.toFixed(2)})`); continue; }
              if (step % 2 === 0) mark(col, row, '•', `rgb(241 180 91 / ${(alpha * 0.85).toFixed(2)})`);
              continue;
            }
            mark(col, row, '•', `rgb(200 255 150 / ${(alpha * 0.8).toFixed(2)})`);
          }
          if (farm.status === 'online' && !reduced) {
            for (let packet = 0; packet < 2; packet += 1) {
              const t = (seconds * 0.35 + index * 0.3 + packet * 0.5) % 1;
              const point = arcPoint(source, target, t, 0.004);
              const p = screen(point.lat, point.lon, point.h);
              mark(colOf(p.sx), rowOf(p.sy), '■', `rgb(216 255 158 / ${alpha.toFixed(2)})`);
            }
          }
        });
      }

      for (const [color, list] of buckets) {
        ctx.fillStyle = color;
        for (const [col, row, char] of list) {
          if (overlay.has(`${col}:${row}`)) continue;
          ctx.fillText(char, cellX(col), cellY(row));
        }
      }
      for (const [col, row, char, color] of overlay.values()) {
        ctx.fillStyle = color;
        ctx.fillText(char, cellX(col), cellY(row));
      }

      // Pontos e rótulos.
      ctx.textAlign = 'left';
      const labelFont = `600 ${Math.max(9, fontSize - 1)}px ${MONO}`;
      ctx.font = labelFont;
      if (global > 0.3) {
        const alpha = clamp((global - 0.3) / 0.5);
        for (const place of [HUB, ...PLACES]) {
          const p = screen(place.lat, place.lon);
          if (p.z < 0.12) continue;
          const hub = place === HUB;
          const pulse = reduced ? 0.5 : (Math.sin(seconds * 2.4 + place.lon) + 1) / 2;
          ctx.fillStyle = hub ? `rgb(216 255 158 / ${alpha})` : `rgb(200 255 170 / ${((0.55 + pulse * 0.45) * alpha).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, hub ? 3.2 : 2.2, 0, Math.PI * 2);
          ctx.fill();
          if (hub) {
            ctx.strokeStyle = `rgb(216 255 158 / ${((0.25 + (1 - pulse) * 0.35) * alpha).toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(p.sx, p.sy, 7 + pulse * 6, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = hub ? `rgb(232 255 210 / ${(0.95 * alpha).toFixed(2)})` : `rgb(190 230 180 / ${(Math.min(0.8, p.z) * alpha).toFixed(2)})`;
          ctx.fillText(place.code, p.sx + 8, p.sy - 8);
        }
      }

      if (local > 0.4) {
        const alpha = clamp((local - 0.4) / 0.4);
        ctx.textAlign = 'center';
        for (const [name, lat, lon] of STATES) {
          const p = screen(lat, lon);
          if (p.z <= 0 || p.sx < 20 || p.sx > width - 20 || p.sy < 12 || p.sy > height - 12) continue;
          const main = name === 'MATO GROSSO';
          ctx.font = main ? `700 ${fontSize + 3}px ${MONO}` : labelFont;
          ctx.fillStyle = main ? `rgb(236 217 164 / ${(0.9 * alpha).toFixed(2)})` : `rgb(150 190 155 / ${(0.6 * alpha).toFixed(2)})`;
          ctx.fillText(main ? 'M A T O   G R O S S O' : name, p.sx, p.sy);
        }
        ctx.font = labelFont;
        const pulse = reduced ? 0.5 : (Math.sin(seconds * 2.4) + 1) / 2;
        const places: Array<{ label: string; short: string; lat: number; lon: number; side: number; dy: number; color: string; hub?: boolean }> = [
          { ...MATRIZ, side: 1, dy: -10, color: '232 255 210', hub: true },
          ...FARMS.map((farm) => ({ ...farm, color: FARM_COLORS[farm.status] })),
        ];
        for (const place of places) {
          const p = screen(place.lat, place.lon);
          ctx.fillStyle = `rgb(${place.color} / ${alpha.toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, place.hub ? 4 : 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = `rgb(${place.color} / ${((0.2 + (1 - pulse) * 0.4) * alpha).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, (place.hub ? 9 : 7) + pulse * 5, 0, Math.PI * 2);
          ctx.stroke();
          // Fundo escuro atrás do rótulo para separá-lo das lavouras.
          // Em telas estreitas os rótulos encurtam; o estado continua na cor do ponto.
          const text = narrow ? place.short : place.label;
          const textWidth = ctx.measureText(text).width;
          const labelX = clamp(place.side > 0 ? p.sx + 12 : p.sx - 12 - textWidth, 6, width - textWidth - 6);
          const labelY = p.sy + place.dy;
          ctx.fillStyle = `rgb(4 7 5 / ${(0.82 * alpha).toFixed(2)})`;
          ctx.fillRect(labelX - 5, labelY - fontSize * 0.75, textWidth + 10, fontSize * 1.5);
          ctx.textAlign = 'left';
          ctx.fillStyle = `rgb(${place.color} / ${(0.95 * alpha).toFixed(2)})`;
          ctx.fillText(text, labelX, labelY);
        }
      }
    }

    // Relógio próprio: pausar congela a linha do tempo e a rotação.
    let clock = 0;
    function tick(now: number) {
      frame = requestAnimationFrame(tick);
      if (!visible || now - last < 33) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (pausedRef.current) return;
      clock += dt;
      if (!dragging) {
        velocity *= 0.94;
        spin = wrap(spin + 5.5 * dt + velocity * dt);
      }
      draw(clock);
    }

    resize();
    if (reduced) draw(0);
    else frame = requestAnimationFrame(tick);

    const resizeObserver = new ResizeObserver(() => { resize(); draw(reduced ? 0 : clock); });
    resizeObserver.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting && !document.hidden; });
    intersection.observe(canvas);
    const onVisibility = () => { visible = !document.hidden; };
    document.addEventListener('visibilitychange', onVisibility);

    const onDown = (event: PointerEvent) => {
      if (reduced) return;
      dragging = { x: event.clientX, spin };
      canvas.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      const next = dragging.spin - ((event.clientX - dragging.x) / Math.max(1, width)) * 180;
      velocity = (next - spin) * 20;
      spin = wrap(next);
    };
    const onUp = () => { dragging = null; };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    return () => {
      cancelSchedule(rasterTask);
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, [reduced, scene]);

  return (
    <div className={styles.globeFrame}>
      <canvas ref={canvasRef} className={className} aria-hidden="true" data-malha-globe />
      {!reduced && controlled === undefined && (
        <button type="button" className={styles.globePause} aria-pressed={paused} onClick={() => setPaused((value) => !value)}
          aria-label={paused ? 'Retomar a animação do globo' : 'Pausar a animação do globo'}>
          {paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}
