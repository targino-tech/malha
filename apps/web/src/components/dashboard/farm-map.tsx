'use client';

import { useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MT_OUTLINE, NEIGHBOR_OUTLINES } from '../../app/site/_components/mt-outline';
import type { DashboardFarm } from '../../server/dashboard';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const PARCELS = '=-+:;=%-';
const STATUS = {
  online: { color: '182 243 122', label: 'Coletor em contato' },
  offline: { color: '255 143 133', label: 'Coletor sem contato' },
  missing: { color: '154 172 157', label: 'Sem coletor' },
} as const;

function hash(x: number, y: number) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function inside(outline: readonly number[], lon: number, lat: number) {
  let result = false;
  const n = outline.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const xi = outline[i * 2], yi = outline[i * 2 + 1], xj = outline[j * 2], yj = outline[j * 2 + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

type Box = { west: number; east: number; south: number; north: number };

// Enquadra Mato Grosso e todas as fazendas com coordenadas, com uma margem.
function frame(farms: DashboardFarm[]): Box {
  const lons = [-61.6, -50.2, ...farms.map((farm) => farm.longitude!).filter((value) => value !== null)];
  const lats = [-18.1, -7.3, ...farms.map((farm) => farm.latitude!).filter((value) => value !== null)];
  const pad = 0.8;
  return { west: Math.min(...lons) - pad, east: Math.max(...lons) + pad, south: Math.min(...lats) - pad, north: Math.max(...lats) + pad };
}

export function FarmMap({ farms, onOpenFarm }: { farms: DashboardFarm[]; onOpenFarm: (id: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const located = useMemo(() => farms.filter((farm) => farm.latitude !== null && farm.longitude !== null), [farms]);
  const box = useMemo(() => frame(located), [located]);

  // Projeção equirretangular com correção de latitude: suficiente na escala de um estado.
  const project = useMemo(() => {
    const midLat = ((box.north + box.south) / 2) * Math.PI / 180;
    const spanX = (box.east - box.west) * Math.cos(midLat);
    const spanY = box.north - box.south;
    const scale = Math.min(size.width / spanX, size.height / spanY);
    const offsetX = (size.width - spanX * scale) / 2;
    const offsetY = (size.height - spanY * scale) / 2;
    return {
      toScreen: (lon: number, lat: number) => ({ x: offsetX + (lon - box.west) * Math.cos(midLat) * scale, y: offsetY + (box.north - lat) * scale }),
      toGeo: (x: number, y: number) => ({ lon: box.west + (x - offsetX) / (Math.cos(midLat) * scale), lat: box.north - (y - offsetY) / scale }),
    };
  }, [box, size]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !size.width || !size.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const fontSize = size.width < 480 ? 9 : 11;
    context.font = `500 ${fontSize}px ${MONO}`;
    const cellW = context.measureText('M').width;
    const cellH = Math.round(fontSize * 1.2);
    const cols = Math.ceil(size.width / cellW);
    const rows = Math.ceil(size.height / cellH);
    let frameId = 0;
    let last = 0;
    const start = performance.now();

    // A base (lavouras e contornos) é desenhada uma vez; só os pulsos das fazendas se repetem.
    const base = document.createElement('canvas');
    base.width = canvas.width;
    base.height = canvas.height;
    const ctx = base.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.font = `500 ${fontSize}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = col * cellW + cellW / 2;
        const y = row * cellH + cellH / 2;
        const { lon, lat } = project.toGeo(x, y);
        if (inside(MT_OUTLINE, lon, lat)) {
          const h = hash(Math.floor(lon / 0.42), Math.floor(lat / 0.3));
          const wheat = h > 0.62;
          ctx.fillStyle = wheat ? `rgb(217 184 102 / ${(0.2 + h * 0.2).toFixed(2)})` : `rgb(150 220 120 / ${(0.16 + h * 0.22).toFixed(2)})`;
          ctx.fillText(PARCELS[Math.floor(h * PARCELS.length)], x, y);
        } else if (hash(col, row) > 0.86) {
          ctx.fillStyle = 'rgb(110 150 115 / .16)';
          ctx.fillText('.', x, y);
        }
      }
    }
    const trace = (outline: readonly number[], color: string, char: string, spacing: number) => {
      ctx.fillStyle = color;
      const n = outline.length / 2;
      for (let i = 0; i < n; i += 1) {
        const a = project.toScreen(outline[i * 2], outline[i * 2 + 1]);
        const j = (i + 1) % n;
        const b = project.toScreen(outline[j * 2], outline[j * 2 + 1]);
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing));
        for (let s = 0; s < steps; s += 1) {
          const x = a.x + ((b.x - a.x) * s) / steps;
          const y = a.y + ((b.y - a.y) * s) / steps;
          ctx.fillText(char, Math.floor(x / cellW) * cellW + cellW / 2, Math.floor(y / cellH) * cellH + cellH / 2);
        }
      }
    };
    for (const outline of NEIGHBOR_OUTLINES) trace(outline, 'rgb(150 200 150 / .28)', '·', cellW * 1.6);
    trace(MT_OUTLINE, 'rgb(236 217 164 / .85)', '•', cellW * 0.9);

    function draw(now: number) {
      const c = context!;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, canvas!.width, canvas!.height);
      c.drawImage(base, 0, 0);
      c.setTransform(ratio, 0, 0, ratio, 0, 0);
      const t = (now - start) / 1000;
      for (const farm of located) {
        const { x, y } = project.toScreen(farm.longitude!, farm.latitude!);
        const tone = STATUS[farm.collectorStatus].color;
        const pulse = reduced ? 0.5 : (Math.sin(t * (farm.collectorStatus === 'offline' ? 4 : 2)) + 1) / 2;
        c.strokeStyle = `rgb(${tone} / ${(0.18 + (1 - pulse) * 0.4).toFixed(2)})`;
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(x, y, 9 + pulse * (farm.collectorStatus === 'offline' ? 9 : 5), 0, Math.PI * 2);
        c.stroke();
      }
    }
    function tick(now: number) {
      frameId = requestAnimationFrame(tick);
      if (now - last < 50) return;
      last = now;
      draw(now);
    }
    if (reduced) draw(start);
    else frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [located, project, reduced, size]);

  const unlocated = farms.length - located.length;
  return (
    <div className="farm-map">
      <div className="farm-map-stage" ref={wrapRef}>
        <canvas ref={canvasRef} aria-hidden="true" />
        <ul className="farm-map-pins" aria-label="Fazendas no mapa">
          {size.width > 0 && located.map((farm) => {
            const { x, y } = project.toScreen(farm.longitude!, farm.latitude!);
            const status = STATUS[farm.collectorStatus];
            // Fazendas a oeste do centro do enquadramento rotulam à esquerda: separa sedes próximas.
            const left = x < size.width * 0.5;
            return (
              <li key={farm.id} style={{ left: x, top: y }} data-side={left ? 'left' : 'right'}>
                <button type="button" className="farm-pin" data-status={farm.collectorStatus} onClick={() => onOpenFarm(farm.id)}
                  aria-label={`${farm.name}: ${status.label.toLowerCase()}, ${farm.assetCount} ativos${farm.offlineCriticalCount ? `, ${farm.offlineCriticalCount} crítico offline` : ''}. Abrir inventário`}>
                  <span className="farm-pin-dot" aria-hidden="true" />
                  <span className="farm-pin-label" aria-hidden="true"><strong>{farm.name.replace(/^Fazenda /, '')}</strong><small>{status.label} · {farm.assetCount} ativos</small></span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="farm-map-note">
        {located.length ? `${located.length} ${located.length === 1 ? 'fazenda posicionada' : 'fazendas posicionadas'} pelas coordenadas da sede.` : 'Nenhuma fazenda com coordenadas ainda.'}
        {unlocated > 0 && ` ${unlocated} sem coordenadas: cadastre latitude e longitude em Administração.`}
      </p>
    </div>
  );
}
