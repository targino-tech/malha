'use client';

import { useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { isLand, landMask } from './land-mask';

interface Place { code: string; lat: number; lon: number }

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

const LAND_RAMP = '.:-=+*#%@';
const RAD = Math.PI / 180;
const TILT = 14 * RAD;
const LIGHT = normalize([-0.55, 0.55, 0.63]);
const ROUTE_CYCLE = 7.5;

function normalize([x, y, z]: number[]) {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
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

// Projeção ortográfica com o centro em (TILT, center). Retorna coordenadas no espaço da esfera unitária.
function project(lat: number, lon: number, center: number, h = 1) {
  const phi = lat * RAD;
  const dl = (lon - center) * RAD;
  const x = Math.cos(phi) * Math.sin(dl);
  const y = Math.cos(TILT) * Math.sin(phi) - Math.sin(TILT) * Math.cos(phi) * Math.cos(dl);
  const z = Math.sin(TILT) * Math.sin(phi) + Math.cos(TILT) * Math.cos(phi) * Math.cos(dl);
  return { x: x * h, y: y * h, z: z * h, visible: z > 0 || (x * x + y * y) * h * h > 1 };
}

function unproject(x: number, y: number, center: number) {
  const rho = Math.hypot(x, y);
  if (rho === 0) return { lat: TILT / RAD, lon: center };
  const c = Math.asin(Math.min(1, rho));
  const lat = Math.asin(Math.cos(c) * Math.sin(TILT) + (y * Math.sin(c) * Math.cos(TILT)) / rho);
  const lon = center * RAD + Math.atan2(x * Math.sin(c), rho * Math.cos(c) * Math.cos(TILT) - y * Math.sin(c) * Math.sin(TILT));
  return { lat: lat / RAD, lon: lon / RAD };
}

function landColor(shade: number) {
  const g = Math.round(90 + shade * 152);
  const r = Math.round(40 + shade * 150);
  const b = Math.round(50 + shade * 70);
  return `rgb(${r} ${g} ${b})`;
}

export function AsciiGlobe({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const mask = landMask();
    const vectors = new Map<Place, number[]>();
    for (const place of [HUB, ...PLACES]) vectors.set(place, toVector(place.lat, place.lon));

    let width = 0;
    let height = 0;
    let cellW = 7;
    let cellH = 13;
    let fontSize = 12;
    let frame = 0;
    let last = 0;
    let visible = true;
    let center = -42;
    let velocity = 0;
    let dragging: { x: number; center: number } | null = null;
    const start = performance.now();

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas!.width = Math.round(width * ratio);
      canvas!.height = Math.round(height * ratio);
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      fontSize = width < 420 ? 9 : width < 640 ? 10.5 : 12;
      context!.font = `500 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`;
      cellW = context!.measureText('M').width;
      cellH = Math.round(fontSize * 1.18);
    }

    function draw(seconds: number) {
      const ctx = context!;
      ctx.clearRect(0, 0, width, height);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const radius = Math.min(width, height) * 0.45;
      const cx = width / 2;
      const cy = height / 2;
      const cols = Math.ceil(width / cellW);
      const rows = Math.ceil(height / cellH);
      const colOf = (px: number) => Math.floor(px / cellW);
      const rowOf = (py: number) => Math.floor(py / cellH);
      const cellX = (col: number) => col * cellW + cellW / 2;
      const cellY = (row: number) => row * cellH + cellH / 2;

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
            // Halo da atmosfera.
            if (rr < 1.1 && (col + row) % 2 === 0) put('rgb(120 220 140 / 0.16)', col, row, '.');
            continue;
          }
          const nz = Math.sqrt(1 - rr);
          const light = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
          const { lat, lon } = unproject(nx, ny, center);
          if (isLand(mask, lat, lon)) {
            const shade = Math.min(1, 0.18 + light * 0.9);
            const level = Math.round(shade * 6) / 6;
            put(landColor(level), col, row, LAND_RAMP[Math.min(LAND_RAMP.length - 1, Math.floor(shade * LAND_RAMP.length))]);
          } else {
            const latLine = Math.abs(((lat % 20) + 20) % 20) < 0.9;
            const lonLine = Math.abs(((lon % 20) + 20) % 20) < 0.9 * (1 / Math.max(0.2, Math.cos(lat * RAD)));
            if (latLine || lonLine) put(`rgb(110 200 130 / ${(0.1 + light * 0.22).toFixed(2)})`, col, row, '·');
            else if (((col * 7 + row * 13) ^ (row * 5)) % 9 === 0) put(`rgb(80 150 100 / ${(0.04 + light * 0.1).toFixed(2)})`, col, row, '.');
          }
        }
      }

      // Rotas: cada uma percorre o arco, permanece e se apaga em ciclos defasados.
      const routeCells = new Map<string, [number, number, string, string]>();
      ROUTES.forEach(([from, to], index) => {
        const a = vectors.get(from)!;
        const b = vectors.get(to)!;
        const distance = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
        const lift = 0.08 + distance * 0.09;
        const phase = reduced ? 0.7 : ((seconds / ROUTE_CYCLE + index * 0.37) % 1.6);
        const head = Math.min(1, phase * 1.4);
        const tail = Math.max(0, (phase - 0.75) * 1.6);
        if (tail >= head) return;
        const steps = Math.max(10, Math.round(distance * 34));
        for (let step = 0; step <= steps; step += 1) {
          const t = tail + ((head - tail) * step) / steps;
          const point = arcPoint(a, b, t, lift);
          const p = project(point.lat, point.lon, center, point.h);
          if (!p.visible) continue;
          const col = colOf(cx + p.x * radius);
          const row = rowOf(cy - p.y * radius);
          const nearHead = (head - t) < 0.04 && head < 1;
          const key = `${col}:${row}`;
          const char = nearHead ? '●' : '·';
          const alpha = nearHead ? 1 : 0.35 + 0.55 * ((t - tail) / Math.max(0.001, head - tail));
          routeCells.set(key, [col, row, char, nearHead ? '#e8ffd2' : `rgb(176 245 120 / ${alpha.toFixed(2)})`]);
        }
        if (head >= 1 && phase < 1.25) {
          const p = project(to.lat, to.lon, center);
          if (p.z > 0) {
            const ring = (phase - 0.72) * 6;
            const ctxX = cx + p.x * radius;
            const ctxY = cy - p.y * radius;
            ctx.strokeStyle = `rgb(176 245 120 / ${Math.max(0, 0.5 - ring * 0.18).toFixed(2)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(ctxX, ctxY, 4 + ring * 6, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      });

      for (const [color, list] of buckets) {
        ctx.fillStyle = color;
        for (const [col, row, char] of list) {
          if (routeCells.has(`${col}:${row}`)) continue;
          ctx.fillText(char, cellX(col), cellY(row));
        }
      }
      for (const [col, row, char, color] of routeCells.values()) {
        ctx.fillStyle = color;
        ctx.fillText(char, cellX(col), cellY(row));
      }

      // Pontos e rótulos.
      ctx.textAlign = 'left';
      ctx.font = `600 ${Math.max(9, fontSize - 1)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      for (const place of [HUB, ...PLACES]) {
        const p = project(place.lat, place.lon, center);
        if (p.z < 0.12) continue;
        const x = cx + p.x * radius;
        const y = cy - p.y * radius;
        const hub = place === HUB;
        const pulse = reduced ? 0.5 : (Math.sin(seconds * 2.4 + place.lon) + 1) / 2;
        ctx.fillStyle = hub ? '#d8ff9e' : `rgb(200 255 170 / ${(0.55 + pulse * 0.45).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(x, y, hub ? 3.2 : 2.2, 0, Math.PI * 2);
        ctx.fill();
        if (hub) {
          ctx.strokeStyle = `rgb(216 255 158 / ${(0.25 + (1 - pulse) * 0.35).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(x, y, 7 + pulse * 6, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = hub ? 'rgb(232 255 210 / 0.95)' : `rgb(190 230 180 / ${Math.min(0.8, p.z).toFixed(2)})`;
        ctx.fillText(place.code, x + 8, y - 8);
      }
      ctx.font = `500 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`;
    }

    function tick(now: number) {
      frame = requestAnimationFrame(tick);
      if (!visible || now - last < 33) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!dragging) {
        velocity *= 0.94;
        center += 5.5 * dt + velocity * dt;
      }
      draw((now - start) / 1000);
    }

    resize();
    if (reduced) draw(0);
    else frame = requestAnimationFrame(tick);

    const resizeObserver = new ResizeObserver(() => { resize(); draw(reduced ? 0 : (performance.now() - start) / 1000); });
    resizeObserver.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting && !document.hidden; });
    intersection.observe(canvas);
    const onVisibility = () => { visible = !document.hidden; };
    document.addEventListener('visibilitychange', onVisibility);

    const onDown = (event: PointerEvent) => {
      if (reduced) return;
      dragging = { x: event.clientX, center };
      canvas.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      const next = dragging.center - ((event.clientX - dragging.x) / Math.max(1, width)) * 180;
      velocity = (next - center) * 20;
      center = next;
    };
    const onUp = () => { dragging = null; };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, [reduced]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" data-malha-globe />;
}
