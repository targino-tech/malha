'use client';

import { motion, useMotionValueEvent, useReducedMotion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import styles from '../site.module.css';

const steps = [
  {
    label: '01 · Na fazenda',
    title: 'O coletor lê a rede local.',
    text: 'Instalado na fazenda, o coletor consulta a console UniFi pela API oficial, somente com leitura. Envia sinal a cada 60 s e o inventário a cada 5 min.',
  },
  {
    label: '02 · No caminho',
    title: 'Sem internet, nada se perde.',
    text: 'Cada mensagem sai assinada com Ed25519. Se a WAN cair, os lotes ficam guardados no SQLite local e seguem na reconexão, sem duplicar capturas.',
  },
  {
    label: '03 · No painel',
    title: 'A matriz vê o que importa.',
    text: 'Ocorrências por fazenda, alerta de coletor sem contato após 3 min e e-mail para ocorrências críticas. Cada grupo acessa somente as próprias fazendas.',
  },
];

const OUTAGE: [number, number] = [0.42, 0.58];
const HARVEST = 0.7;
const BALES: Array<[number, number]> = [[-0.42, 0.42], [0.32, 0.55], [0.9, 0.8], [-0.95, 0.9], [0.05, 0.3], [0.62, 0.36], [-0.12, 0.72], [0.4, 0.95]];
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

function clamp(value: number, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function noise(x: number, y: number) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function FieldCanvas({ progress, reduced }: { progress: MotionValue<number> | null; reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let width = 0;
    let height = 0;
    let cellW = 7;
    let cellH = 13;
    let fontSize = 12;
    let frame = 0;
    let last = 0;
    let visible = true;
    let queued = 0;
    let flushUntil = 0;
    const start = performance.now();

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas!.width = Math.round(width * ratio);
      canvas!.height = Math.round(height * ratio);
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      fontSize = width < 520 ? 10 : 12;
      context!.font = `500 ${fontSize}px ${MONO}`;
      cellW = context!.measureText('M').width;
      cellH = Math.round(fontSize * 1.2);
    }

    function draw(seconds: number, p: number) {
      const ctx = context!;
      ctx.clearRect(0, 0, width, height);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `500 ${fontSize}px ${MONO}`;
      const cols = Math.ceil(width / cellW);
      const rows = Math.ceil(height / cellH);
      const horizon = Math.round(rows * 0.46);
      const vx = cols * (width < 720 ? 0.5 : 0.66);
      const grid: Array<Array<[string, string] | null>> = Array.from({ length: rows }, () => Array(cols).fill(null));
      const put = (col: number, row: number, char: string, color: string) => {
        const c = Math.round(col);
        const r = Math.round(row);
        if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = [char, color];
      };
      const aspect = cellH / cellW;
      const growth = clamp(p / 0.62);
      const harvest = clamp((p - HARVEST) / 0.12);
      const outage = p > OUTAGE[0] && p < OUTAGE[1];

      // Céu: estrelas e sol baixo que escurece ao longo do percurso.
      for (let row = 0; row < horizon; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const n = noise(col, row);
          if (n > 0.985) {
            const twinkle = reduced ? 0.6 : (Math.sin(seconds * 2 + n * 40) + 1) / 2;
            put(col, row, n > 0.996 ? '+' : '.', `rgb(190 220 190 / ${(0.12 + twinkle * 0.3 * (0.4 + p)).toFixed(2)})`);
          }
        }
      }
      const sunX = vx + cols * 0.1;
      const sunY = horizon - 1 + p * 3;
      const sunR = Math.max(4, rows * 0.13);
      for (let row = Math.floor(sunY - sunR); row <= sunY; row += 1) {
        for (let col = Math.floor(sunX - sunR * aspect); col <= sunX + sunR * aspect; col += 1) {
          const d = Math.hypot((col - sunX) / aspect, row - sunY) / sunR;
          if (d > 1 || row >= horizon) continue;
          const band = (Math.floor(row) % 2 === 0) || d < 0.6;
          if (!band) continue;
          put(col, row, d < 0.55 ? '@' : d < 0.8 ? 'o' : '.', `rgb(${Math.round(232 - p * 40)} ${Math.round(196 - p * 70)} 110 / ${(0.55 - d * 0.3).toFixed(2)})`);
        }
      }
      for (let col = 0; col < cols; col += 1) put(col, horizon, '_', 'rgb(150 200 150 / 0.35)');

      // Lavoura em perspectiva: brota, cresce e vira palhada na colheita.
      for (let row = horizon + 1; row < rows; row += 1) {
        const depth = (row - horizon) / (rows - horizon);
        for (let col = 0; col < cols; col += 1) {
          const u = (col - vx) / (depth * cols * 0.9);
          const lane = (((u / 0.07) % 1) + 1) % 1;
          const inRow = lane < 0.34 + depth * 0.12;
          if (!inRow) {
            if (noise(col, row) > 0.93) put(col, row, '.', `rgb(110 90 60 / ${(0.15 + depth * 0.2).toFixed(2)})`);
            continue;
          }
          const local = clamp(growth * 1.15 - (1 - depth) * 0.15);
          let char = '.';
          if (harvest > noise(col * 0.7, row * 1.3)) {
            char = depth > 0.5 ? (noise(col, row) > 0.5 ? ',' : '_') : '.';
            put(col, row, char, `rgb(214 182 102 / ${(0.35 + depth * 0.45).toFixed(2)})`);
            continue;
          }
          if (local > 0.75) {
            const sway = reduced ? 0 : Math.sin(seconds * 1.6 + col * 0.25 - row * 0.1);
            char = depth > 0.55 ? (sway > 0.45 ? '/' : sway < -0.45 ? '\\' : 'Y') : depth > 0.25 ? 'v' : ',';
          } else if (local > 0.45) char = depth > 0.4 ? 'i' : ',';
          else if (local > 0.15) char = ',';
          const g = Math.round(120 + local * 110);
          put(col, row, char, `rgb(${Math.round(70 + local * 90)} ${g} ${Math.round(70 + local * 30)} / ${(0.35 + depth * 0.6).toFixed(2)})`);
        }
      }

      // Palheiros: fardos redondos que surgem na colheita.
      BALES.forEach(([u, depth], index) => {
        const appear = clamp((p - HARVEST - 0.04 - index * 0.025) / 0.08);
        if (appear <= 0) return;
        const x = vx + u * depth * cols * 0.9;
        const y = horizon + depth * (rows - horizon);
        const radius = (1.2 + depth * 4.2) * appear;
        for (let row = Math.floor(y - radius * 2); row <= y; row += 1) {
          for (let col = Math.floor(x - radius * aspect * 1.05); col <= x + radius * aspect * 1.05; col += 1) {
            const dx = (col - x) / (aspect * 1.05);
            const dy = row - (y - radius);
            const d = Math.hypot(dx, dy) / radius;
            if (d > 1) continue;
            const angle = Math.atan2(dy, dx);
            const spiral = ((d * 3.2 + angle / (Math.PI * 2)) % 1 + 1) % 1;
            const char = d > 0.86 ? (dx < 0 ? '(' : ')') : spiral < 0.45 ? '@' : spiral < 0.75 ? '%' : '=';
            const shade = 0.55 + (1 - d) * 0.35 - (dx > 0 ? 0.12 : 0);
            put(col, row, char, `rgb(${Math.round(226 * shade + 20)} ${Math.round(186 * shade + 10)} ${Math.round(92 * shade)})`);
          }
        }
      });

      // Coletor: torre com antena e rádio.
      const tx = Math.round(cols * (width < 720 ? 0.22 : 0.5));
      const base = horizon + Math.round((rows - horizon) * 0.42);
      const towerH = Math.round(rows * (width < 720 ? 0.24 : 0.3));
      for (let i = 0; i < towerH; i += 1) {
        const row = base - i;
        const spread = Math.max(0, Math.round((towerH - i) / towerH * 2.2));
        put(tx - spread, row, '/', 'rgb(200 225 205 / 0.8)');
        put(tx + spread, row, '\\', 'rgb(200 225 205 / 0.8)');
        if (spread > 0) put(tx, row, i % 2 ? 'x' : '+', 'rgb(160 190 165 / 0.6)');
        else put(tx, row, '|', 'rgb(200 225 205 / 0.9)');
      }
      const top = base - towerH;
      put(tx - 1, top + 2, '[', 'rgb(220 240 220)');
      put(tx, top + 2, '■', outage ? '#f1b45b' : '#b6f37a');
      put(tx + 1, top + 2, ']', 'rgb(220 240 220)');
      put(tx, top - 1, '*', '#d8ff9e');
      const waves = reduced ? [1.5, 3] : [0, 1, 2].map((offset) => ((seconds * 1.4 + offset) % 3) * 1.6);
      for (const wave of waves) {
        const alpha = clamp(1 - wave / 5).toFixed(2);
        put(tx + 2 + wave * aspect * 0.5, top - 1, ')', `rgb(182 243 122 / ${alpha})`);
        put(tx - 2 - wave * aspect * 0.5, top - 1, '(', `rgb(182 243 122 / ${alpha})`);
      }

      // Enlace até o Malha: pontilhado, cortado durante a queda da WAN.
      const nodeX = Math.round(cols * (width < 720 ? 0.74 : 0.86));
      const nodeY = Math.round(rows * 0.14);
      const curve = (t: number) => {
        const cxp = (tx + nodeX) / 2;
        const cyp = Math.min(top, nodeY) - rows * 0.12;
        const x = (1 - t) ** 2 * tx + 2 * (1 - t) * t * cxp + t * t * nodeX;
        const y = (1 - t) ** 2 * (top - 1) + 2 * (1 - t) * t * cyp + t * t * (nodeY + 1);
        return [x, y];
      };
      const length = Math.hypot(nodeX - tx, nodeY - top) * 1.4;
      for (let i = 2; i < length; i += 2) {
        const t = i / length;
        const [x, y] = curve(t);
        const cut = outage && t > 0.42 && t < 0.58;
        if (cut) { if (Math.abs(t - 0.5) < 0.02) put(x, y, '×', '#f1b45b'); continue; }
        put(x, y, '.', 'rgb(160 220 160 / 0.32)');
      }

      // Pacotes: fluem, ficam em fila no coletor durante a queda e são liberados na reconexão.
      const packets = 7;
      const speed = flushUntil > seconds ? 0.55 : 0.18;
      for (let i = 0; i < packets; i += 1) {
        if (outage) break;
        const t = reduced ? i / packets : ((seconds * speed + i / packets) % 1);
        const [x, y] = curve(t);
        put(x, y, '■', `rgb(216 255 158 / ${(0.5 + 0.5 * Math.sin(t * Math.PI)).toFixed(2)})`);
      }
      if (outage) {
        const text = `sem WAN · fila local ${String(queued).padStart(2, '0')}`;
        for (let i = 0; i < text.length; i += 1) put(tx + 3 + i, top + 2, text[i], '#f1b45b');
        for (let i = 0; i < Math.min(6, Math.ceil(queued / 4)); i += 1) put(tx + 3 + i, top + 3, '■', 'rgb(241 180 91 / 0.8)');
      }

      const label = '[ malha ]';
      for (let i = 0; i < label.length; i += 1) put(nodeX - label.length / 2 + i, nodeY, label[i], '#d8ff9e');

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const cell = grid[row][col];
          if (!cell) continue;
          ctx.fillStyle = cell[1];
          ctx.fillText(cell[0], col * cellW + cellW / 2, row * cellH + cellH / 2);
        }
      }
    }

    const currentProgress = () => (reduced || !progress ? 1 : progress.get());

    function tick(now: number) {
      frame = requestAnimationFrame(tick);
      if (!visible || now - last < 40) return;
      last = now;
      const seconds = (now - start) / 1000;
      const p = currentProgress();
      const inOutage = p > OUTAGE[0] && p < OUTAGE[1];
      if (inOutage) queued = Math.min(24, queued + 0.25);
      else if (queued > 0) { flushUntil = seconds + 2.5; queued = 0; }
      draw(seconds, p);
    }

    resize();
    if (reduced) draw(0, 1);
    else frame = requestAnimationFrame(tick);
    const resizeObserver = new ResizeObserver(() => { resize(); draw((performance.now() - start) / 1000, currentProgress()); });
    resizeObserver.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    intersection.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersection.disconnect();
    };
  }, [progress, reduced]);

  return <canvas ref={canvasRef} className={styles.fieldCanvas} aria-hidden="true" data-malha-field />;
}

function Step({ index, progress, step }: { index: number; progress: MotionValue<number>; step: (typeof steps)[number] }) {
  const [edges, fade, shift] = [
    [[0, 0.3, 0.36], [1, 1, 0], [0, 0, -28]],
    [[0.3, 0.36, 0.64, 0.7], [0, 1, 1, 0], [28, 0, 0, -28]],
    [[0.64, 0.7, 1], [0, 1, 1], [28, 0, 0]],
  ][index];
  const opacity = useTransform(progress, edges, fade);
  const y = useTransform(progress, edges, shift);
  return (
    <motion.article className={styles.storyStep} style={{ opacity, y }}>
      <p className={styles.storyLabel}>{step.label}</p>
      <h3>{step.title}</h3>
      <p>{step.text}</p>
    </motion.article>
  );
}

export function FieldStory() {
  const reduced = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const bar = useTransform(scrollYProgress, [0, 1], ['0%', '100%']);
  const [active, setActive] = useState(0);
  useMotionValueEvent(scrollYProgress, 'change', (value) => setActive(value < 0.36 ? 0 : value < 0.7 ? 1 : 2));

  if (reduced) {
    return (
      <div className={styles.storyStatic}>
        <div className={styles.storyStaticCanvas}><FieldCanvas progress={null} reduced /></div>
        <ol className={styles.storyStaticSteps}>
          {steps.map((step) => (
            <li key={step.label} className={styles.storyStep}>
              <p className={styles.storyLabel}>{step.label}</p>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div ref={ref} className={styles.storyTrack}>
      <div className={styles.storySticky}>
        <FieldCanvas progress={scrollYProgress} reduced={false} />
        <div className={styles.storyShade} />
        <div className={styles.storyCopy}>
          {steps.map((step, index) => <Step key={step.label} index={index} progress={scrollYProgress} step={step} />)}
        </div>
        <div className={styles.storyProgress} aria-hidden="true">
          <div className={styles.storyDots}>
            {steps.map((step, index) => <span key={step.label} data-active={index === active}>{String(index + 1).padStart(2, '0')}</span>)}
          </div>
          <div className={styles.storyBar}><motion.span style={{ width: bar }} /></div>
        </div>
      </div>
    </div>
  );
}
