'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useReducedMotion } from 'motion/react';
import {
  Box, ChartNetwork, CircleCheck, CircleHelp, CircleX, FlaskConical, Maximize, Network, RadioTower, RefreshCw, Router, Star, Table2, Tag, Wifi, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { DashboardFarm } from '../../server/dashboard';
import type { DevicePort, DevicePorts, DeviceRole, Topology as TopologyData, TrafficSeries, VlanSummary, VlanSummaryItem } from '../../server/network/types';
import { EmptyState, formatDate, requestJson, wholeNumber } from './presentation';
import {
  buildGraph, deviceCarriesVlan, edgePath, formatBps, formatSpeed, isStale, latestObservation, navigate, NODE_HEIGHT, NODE_WIDTH, portCarriesVlan,
  readingOrder, type GraphEdge, type GraphNode, type TopologyGraph,
} from './topology-graph';
import styles from './topology.module.css';

const ROLES: Record<DeviceRole, { label: string; icon: typeof Router }> = {
  gateway: { label: 'Gateway', icon: Router },
  switch: { label: 'Switch', icon: Network },
  ap: { label: 'Ponto de acesso', icon: Wifi },
  radio: { label: 'Rádio', icon: RadioTower },
  other: { label: 'Outro', icon: Box },
};
const STATUS = {
  online: { label: 'Online', icon: CircleCheck },
  offline: { label: 'Offline', icon: CircleX },
  unknown: { label: 'Indeterminado', icon: CircleHelp },
} as const;
const EVIDENCE: Record<GraphEdge['evidence'], string> = {
  unifi_uplink: 'uplink informado pelo UniFi',
  lldp: 'vizinhança LLDP',
  synthetic: 'dado fictício do demo',
};
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const VLAN_PORT_FETCH_LIMIT = 150;
const PORT_TREND_LIMIT = 48;

type View = { x: number; y: number; k: number };
type Loaded<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const truncate = (value: string, size: number) => value.length > size ? `${value.slice(0, size - 1)}…` : value;
const errorText = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

function linkLabel(edge: GraphEdge) {
  return edge.portToPort ? `porta a porta (porta ${edge.fromPortIdx} → porta ${edge.toPortIdx})` : 'entre dispositivos, sem evidência das portas';
}

function nodeSummary(node: GraphNode) {
  const role = ROLES[node.role].label;
  if (node.ports) return `${role} · ${wholeNumber.format(node.ports.up)}/${wholeNumber.format(node.ports.total)} portas`;
  if (node.uplink) return `${role} · RX ${formatBps(node.uplink.rxBps)}`;
  return node.ip ? `${role} · ${node.ip}` : role;
}

function nodeLabel(node: GraphNode, graph: TopologyGraph, vlan: boolean | null | undefined) {
  const parts = [node.name, ROLES[node.role].label, STATUS[node.status].label];
  if (node.critical) parts.push('crítico');
  if (node.ports) parts.push(`${node.ports.up} de ${node.ports.total} portas ativas`);
  if (node.parent) parts.push(`a jusante de ${graph.byId.get(node.parent)!.name}`);
  else if (node.group === 'unlinked') parts.push('sem ligação conhecida');
  if (node.children.length) parts.push(`${node.children.length} a jusante`);
  if (vlan === true) parts.push('leva a VLAN filtrada');
  if (vlan === false) parts.push('não leva a VLAN filtrada');
  if (vlan === null) parts.push('VLAN por porta não informada');
  return parts.join(', ');
}

/** Executa tarefas com no máximo `limit` em paralelo. */
async function pooled<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
  }));
}

// ---------------------------------------------------------------------------------------------- tendência

function Sparkline({ series, label }: { series: TrafficSeries; label: string }) {
  const width = 96;
  const height = 24;
  const from = Date.parse(series.from);
  const span = Math.max(1, Date.parse(series.to) - from);
  const max = Math.max(1, ...series.points.map((point) => Math.max(point.rxBps, point.txBps)));
  // Lacuna: mais que o dobro do espaçamento típico entre amostras (a fonte pode amostrar mais devagar que o agrupamento).
  const steps = series.points.slice(1).map((point, index) => Date.parse(point.t) - Date.parse(series.points[index]!.t)).sort((a, b) => a - b);
  const gapMs = Math.max(series.bucketSeconds * 1000, steps[Math.floor(steps.length / 2)] ?? 0) * 2;
  const path = (key: 'rxBps' | 'txBps') => {
    let d = '';
    let previous: number | null = null;
    for (const point of series.points) {
      const t = Date.parse(point.t);
      const x = ((t - from) / span) * width;
      const y = height - (point[key] / max) * (height - 2) - 1;
      // Intervalo sem amostra é lacuna, não zero: a linha recomeça depois dele.
      const gap = previous === null || t - previous > gapMs;
      d += `${gap ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)} `;
      previous = t;
    }
    return d;
  };
  if (!series.points.length) return <span className="cell-detail">Sem amostras</span>;
  const peak = Math.max(...series.points.map((point) => point.rxMaxBps));
  return (
    <>
      <svg className={styles.spark} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <path className={styles.sparkRx} d={path('rxBps')} />
        <path className={styles.sparkTx} d={path('txBps')} />
      </svg>
      <span className="visually-hidden">{label}: pico de recepção {formatBps(peak)} nas últimas 24 horas.</span>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- grafo

function TopologyCanvas({ graph, title, selectedId, vlanState, onSelect }: {
  graph: TopologyGraph; title: string; selectedId: string | null; vlanState: Map<string, boolean | null> | null;
  onSelect: (id: string | null) => void;
}) {
  const hintId = useId();
  const reduced = useReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const viewRef = useRef(view);
  const tween = useRef<number | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; distance: number | null }>({ moved: false, distance: null });
  const order = useMemo(() => readingOrder(graph), [graph]);

  const apply = useCallback((next: View, animate: boolean) => {
    if (tween.current !== null) cancelAnimationFrame(tween.current);
    tween.current = null;
    if (!animate || reduced) {
      viewRef.current = next;
      setView(next);
      return;
    }
    const start = viewRef.current;
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / 220);
      const ease = 1 - (1 - t) ** 3;
      const current = { x: start.x + (next.x - start.x) * ease, y: start.y + (next.y - start.y) * ease, k: start.k + (next.k - start.k) * ease };
      viewRef.current = current;
      setView(current);
      tween.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    tween.current = requestAnimationFrame(step);
  }, [reduced]);

  const fit = useCallback((animate = true) => {
    const { width, height } = size;
    if (!width || !height) return;
    const pad = 32;
    const k = clamp(Math.min((width - pad * 2) / graph.bounds.width, (height - pad * 2) / graph.bounds.height, 1.2), MIN_ZOOM, MAX_ZOOM);
    apply({ k, x: (width - graph.bounds.width * k) / 2, y: Math.max(pad, (height - graph.bounds.height * k) / 2) }, animate);
  }, [apply, graph.bounds.height, graph.bounds.width, size]);

  const zoomBy = useCallback((factor: number, cx = size.width / 2, cy = size.height / 2) => {
    const current = viewRef.current;
    const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
    apply({ k, x: cx - (cx - current.x) * (k / current.k), y: cy - (cy - current.y) * (k / current.k) }, false);
  }, [apply, size.height, size.width]);

  const reveal = useCallback((id: string) => {
    const node = graph.byId.get(id);
    if (!node || !size.width) return;
    const { x, y, k } = viewRef.current;
    const left = node.x * k + x;
    const top = node.y * k + y;
    const pad = 24;
    if (left >= pad && top >= pad && left + NODE_WIDTH * k <= size.width - pad && top + NODE_HEIGHT * k <= size.height - pad) return;
    apply({ k, x: size.width / 2 - (node.x + NODE_WIDTH / 2) * k, y: size.height / 2 - (node.y + NODE_HEIGHT / 2) * k }, true);
  }, [apply, graph.byId, size.height, size.width]);

  const zoomRef = useRef(zoomBy);
  useEffect(() => { zoomRef.current = zoomBy; }, [zoomBy]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    // Ctrl/Cmd + rolagem (e o gesto de pinça do trackpad) aproxima; a rolagem simples continua rolando a página.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      zoomRef.current(Math.exp(-event.deltaY * 0.0025), event.clientX - box.left, event.clientY - box.top);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, []);

  // Ajusta à tela quando chega um grafo novo; redimensionar a janela não desfaz o zoom de quem está navegando.
  const fitted = useRef<TopologyGraph | null>(null);
  useEffect(() => {
    if (!size.width || fitted.current === graph) return;
    fitted.current = graph;
    queueMicrotask(() => fit(false));
  }, [fit, graph, size.width]);
  useEffect(() => () => { if (tween.current !== null) cancelAnimationFrame(tween.current); }, []);
  useEffect(() => { if (selectedId) queueMicrotask(() => reveal(selectedId)); }, [reveal, selectedId]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest('button')) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.current = { moved: false, distance: null };
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      if (!gesture.current.moved) {
        event.currentTarget.setPointerCapture(event.pointerId);
        setPanning(true);
      }
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.current.distance) {
        const box = host.current!.getBoundingClientRect();
        zoomBy(distance / gesture.current.distance, (a.x + b.x) / 2 - box.left, (a.y + b.y) / 2 - box.top);
      }
      gesture.current = { moved: true, distance };
      return;
    }
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (!gesture.current.moved && Math.hypot(dx, dy) < 3) {
      pointers.current.set(event.pointerId, previous);
      return;
    }
    if (!gesture.current.moved) {
      // A captura só começa quando o gesto vira arrasto, para o clique num nó continuar chegando ao nó.
      gesture.current.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanning(true);
    }
    const current = viewRef.current;
    apply({ ...current, x: current.x + dx, y: current.y + dy }, false);
  }
  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) gesture.current.distance = null;
    if (!pointers.current.size) setPanning(false);
  }

  function focusNode(id: string | null) {
    if (!id) return;
    setFocusId(id);
    nodeRefs.current.get(id)?.focus();
    reveal(id);
  }
  function onNodeKey(event: ReactKeyboardEvent<SVGGElement>, id: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(id);
      return;
    }
    const next = navigate(graph, id, event.key);
    if (next !== null || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) event.preventDefault();
    focusNode(next);
  }
  function onCanvasKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(0.8); }
    else if (event.key === '0') { event.preventDefault(); fit(); }
    else if (event.key === 'Escape' && selectedId) { event.preventDefault(); onSelect(null); }
  }

  const activeId = (focusId && graph.byId.has(focusId) ? focusId : null) ?? (selectedId && graph.byId.has(selectedId) ? selectedId : null) ?? order[0];
  const vlanOf = (id: string) => vlanState ? (vlanState.has(id) ? vlanState.get(id)! : null) : undefined;
  const vlanAttr = (value: boolean | null | undefined) => value === undefined ? undefined : value === true ? 'yes' : value === false ? 'no' : 'unknown';

  return (
    <div ref={host} className={styles.canvas} data-panning={panning || undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onKeyDown={onCanvasKey}>
      <svg role="group" aria-label={title} aria-describedby={hintId} width={size.width} height={size.height}>
        <defs>
          <pattern id="topology-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgb(255 143 133 / .22)" strokeWidth="2" />
          </pattern>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {graph.unlinkedTop !== null && (
            <g aria-hidden="true">
              {graph.roots.length > 0 && <line className={styles.groupRule} x1={0} x2={graph.bounds.width} y1={graph.unlinkedTop - 20} y2={graph.unlinkedTop - 20} />}
              <text className={styles.groupLabel} x={0} y={graph.unlinkedTop + 12}>Sem ligação conhecida</text>
            </g>
          )}
          <g aria-hidden="true">
            {graph.edges.map((edge) => {
              const down = graph.byId.get(edge.from)!;
              const up = graph.byId.get(edge.to)!;
              const vlan = vlanState ? (vlanOf(edge.from) === true && vlanOf(edge.to) === true ? 'yes' : 'no') : undefined;
              const active = selectedId !== null && (edge.from === selectedId || edge.to === selectedId);
              return (
                <path key={edge.id} className={styles.edge} d={edgePath(up, down)} data-level={edge.portToPort ? 'port' : 'device'}
                  data-primary={String(edge.primary)} data-down={down.status === 'offline' || up.status === 'offline' || undefined}
                  data-vlan={vlan} data-active={active || undefined} />
              );
            })}
            {graph.edges.filter((edge) => edge.portToPort).map((edge) => {
              const down = graph.byId.get(edge.from)!;
              const up = graph.byId.get(edge.to)!;
              const labels = [
                { key: 'up', x: up.x + NODE_WIDTH / 2, y: up.y + NODE_HEIGHT + 12, text: `P${edge.toPortIdx}` },
                { key: 'down', x: down.x + NODE_WIDTH / 2, y: down.y - 12, text: `P${edge.fromPortIdx}` },
              ];
              return labels.map((label) => (
                <g key={`${edge.id}-${label.key}`} className={styles.portLabel} transform={`translate(${label.x} ${label.y})`}>
                  <rect x={-15} y={-8} width={30} height={16} rx={8} />
                  <text textAnchor="middle" dy="3.5">{label.text}</text>
                </g>
              ));
            })}
          </g>
          {graph.nodes.map((node) => {
            const Role = ROLES[node.role].icon;
            const Status = STATUS[node.status].icon;
            const vlan = vlanOf(node.assetId);
            return (
              <g key={node.assetId} ref={(element) => { if (element) nodeRefs.current.set(node.assetId, element); else nodeRefs.current.delete(node.assetId); }}
                className={styles.node} transform={`translate(${node.x} ${node.y})`} role="button" tabIndex={node.assetId === activeId ? 0 : -1}
                aria-label={nodeLabel(node, graph, vlan)} aria-pressed={selectedId === node.assetId} data-status={node.status}
                data-selected={selectedId === node.assetId || undefined} data-vlan={vlanAttr(vlan)}
                onFocus={() => setFocusId(node.assetId)} onKeyDown={(event) => onNodeKey(event, node.assetId)}
                onClick={() => { if (!gesture.current.moved) onSelect(node.assetId); }}>
                <rect className={styles.nodeBox} width={NODE_WIDTH} height={NODE_HEIGHT} rx={10} />
                {node.status === 'offline' && <rect className={styles.hatch} width={NODE_WIDTH} height={NODE_HEIGHT} rx={10} />}
                <circle className={styles.iconDisc} cx={28} cy={NODE_HEIGHT / 2} r={17} />
                <Role className={styles.roleIcon} x={18} y={NODE_HEIGHT / 2 - 10} width={20} height={20} aria-hidden="true" />
                <text className={styles.nodeName} x={54} y={28}>{truncate(node.name, node.critical ? 18 : 20)}</text>
                <text className={styles.nodeMeta} x={54} y={46}>{truncate(nodeSummary(node), 27)}</text>
                <Status className={styles.statusIcon} data-status={node.status} x={NODE_WIDTH - 22} y={9} width={14} height={14} aria-hidden="true" />
                {node.critical && <Star className={styles.criticalMark} x={NODE_WIDTH - 40} y={9.5} width={13} height={13} aria-hidden="true" />}
              </g>
            );
          })}
        </g>
      </svg>
      <div className={styles.controls}>
        <button type="button" onClick={() => zoomBy(1.25)} aria-label="Aproximar" title="Aproximar (+)"><ZoomIn size={18} aria-hidden="true" /></button>
        <button type="button" onClick={() => zoomBy(0.8)} aria-label="Afastar" title="Afastar (−)"><ZoomOut size={18} aria-hidden="true" /></button>
        <button type="button" onClick={() => fit()} aria-label="Ajustar à tela" title="Ajustar à tela (0)"><Maximize size={18} aria-hidden="true" /></button>
      </div>
      <p id={hintId} className={styles.hint}>
        Setas percorrem a hierarquia, Enter abre o detalhe. Arraste para mover; Ctrl + rolagem ou pinça para aproximar; 0 ajusta.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- tabelas

function GraphTables({ graph, onSelect }: { graph: TopologyGraph; onSelect: (id: string) => void }) {
  const order = readingOrder(graph).map((id) => graph.byId.get(id)!);
  const name = (id: string) => graph.byId.get(id)!.name;
  return (
    <div className={styles.tables}>
      <div className="table-container" role="region" tabIndex={0} aria-label="Tabela de equipamentos da topologia">
        <table>
          <caption className="visually-hidden">Equipamentos de rede da fazenda, na ordem da hierarquia</caption>
          <thead><tr><th scope="col">Equipamento</th><th scope="col">Papel</th><th scope="col">Estado</th><th scope="col">IP</th>
            <th scope="col">Portas ativas</th><th scope="col">Uplink RX / TX</th><th scope="col">A montante</th></tr></thead>
          <tbody>{order.map((node) => (
            <tr key={node.assetId}>
              <th scope="row"><button type="button" className={styles.linkButton} onClick={() => onSelect(node.assetId)}>{node.name}</button>
                {node.critical && <span className="cell-detail">Crítico</span>}</th>
              <td>{ROLES[node.role].label}</td>
              <td>{STATUS[node.status].label}</td>
              <td className="technical">{node.ip ?? '—'}</td>
              <td className="technical">{node.ports ? `${wholeNumber.format(node.ports.up)} de ${wholeNumber.format(node.ports.total)}` : 'Não lidas'}</td>
              <td className="technical">{node.uplink ? `${formatBps(node.uplink.rxBps)} / ${formatBps(node.uplink.txBps)}` : '—'}</td>
              <td>{node.parent ? name(node.parent) : node.group === 'unlinked' ? 'Sem ligação conhecida' : 'Raiz'}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="table-container" role="region" tabIndex={0} aria-label="Tabela de ligações da topologia">
        <table>
          <caption className="visually-hidden">Ligações entre equipamentos com o nível de evidência</caption>
          <thead><tr><th scope="col">A jusante</th><th scope="col">A montante</th><th scope="col">Nível</th><th scope="col">Evidência</th><th scope="col">Última observação</th></tr></thead>
          <tbody>{graph.edges.length ? graph.edges.map((edge) => (
            <tr key={edge.id}>
              <th scope="row">{name(edge.from)}{edge.portToPort && <span className="cell-detail">porta {edge.fromPortIdx}</span>}</th>
              <td>{name(edge.to)}{edge.portToPort && <span className="cell-detail">porta {edge.toPortIdx}</span>}</td>
              <td>{edge.portToPort ? 'Porta a porta' : 'Entre dispositivos'}{!edge.primary && <span className="cell-detail">Ligação adicional</span>}</td>
              <td>{EVIDENCE[edge.evidence]}</td>
              <td className="technical">{formatDate(edge.lastSeenAt)}</td>
            </tr>
          )) : <tr><td colSpan={5}>Nenhuma ligação com evidência nesta fazenda.</td></tr>}</tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- detalhe

function portState(state: string) {
  if (state === 'UP') return 'Ativa';
  if (state === 'DOWN') return 'Inativa';
  return state.charAt(0) + state.slice(1).toLowerCase();
}

function poeText(poe: DevicePort['poe']) {
  if (!poe) return '—';
  if (poe.enabled === false) return 'Desligado';
  const state = poe.state === 'UP' ? 'Fornecendo' : poe.state === 'OFF' ? 'Sem carga' : poe.state ?? 'Habilitado';
  const power = poe.powerMw !== null ? ` · ${(poe.powerMw / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} W` : '';
  return `${state}${poe.standard ? ` (${poe.standard})` : ''}${power}`;
}

const vlanName = (vlan: { vlanId: number; name: string | null }) => vlan.name ? `${vlan.vlanId} · ${vlan.name}` : String(vlan.vlanId);

function NodeDetail({ node, graph, farmId, ports, vlan, online, onClose }: {
  node: GraphNode; graph: TopologyGraph; farmId: string; ports: Loaded<DevicePorts> | undefined; vlan: VlanSummaryItem | null; online: boolean;
  onClose: () => void;
}) {
  const headingId = useId();
  const [uplinkTrend, setUplinkTrend] = useState<Loaded<TrafficSeries>>({ status: 'loading' });
  const [portTrends, setPortTrends] = useState<Record<number, TrafficSeries>>({});
  const upstream = graph.edges.filter((edge) => edge.from === node.assetId);
  const downstream = graph.edges.filter((edge) => edge.to === node.assetId);
  const portList = ports?.status === 'ready' ? ports.data.ports : null;

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ farmId, assetId: node.assetId, period: '24h' });
    queueMicrotask(() => setUplinkTrend({ status: 'loading' }));
    requestJson<TrafficSeries>(`/api/network/traffic?${params}`, { signal: controller.signal })
      .then((data) => setUplinkTrend({ status: 'ready', data }))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setUplinkTrend({ status: 'error', message: errorText(reason, 'Falha ao carregar o tráfego.') }); });
    return () => controller.abort();
  }, [farmId, node.assetId, online]);

  useEffect(() => {
    if (!online || !portList) return;
    const controller = new AbortController();
    queueMicrotask(() => setPortTrends({}));
    // Só portas com taxa por contador têm série própria; as demais mostram travessão.
    const wanted = portList.filter((port) => port.rxBps !== null || port.txBps !== null).slice(0, PORT_TREND_LIMIT);
    void pooled(wanted, 3, async (port) => {
      if (controller.signal.aborted) return;
      const params = new URLSearchParams({ farmId, assetId: node.assetId, portIdx: String(port.idx), period: '24h' });
      try {
        const series = await requestJson<TrafficSeries>(`/api/network/traffic?${params}`, { signal: controller.signal });
        if (!controller.signal.aborted && series.points.length) setPortTrends((current) => ({ ...current, [port.idx]: series }));
      } catch { /* a tendência é complementar: a taxa atual continua na tabela */ }
    });
    return () => controller.abort();
  }, [farmId, node.assetId, online, portList]);

  const synthetic = portList?.some((port) => port.synthetic) || upstream.some((edge) => edge.synthetic);
  const carrying = vlan?.vlanId !== null && vlan?.vlanId !== undefined && portList ? portList.filter((port) => portCarriesVlan(port, vlan.vlanId!)).length : null;

  return (
    <>
    <aside className={`panel ${styles.detail}`} aria-labelledby={headingId}>
      <div className={styles.detailHeading}>
        <div>
          <h2 id={headingId}>{node.name}</h2>
          <p>{ROLES[node.role].label}{node.model ? ` · ${node.model}` : ''}{node.vendor ? ` · ${node.vendor}` : ''}</p>
        </div>
        <button type="button" className="button icon-button" onClick={onClose} aria-label="Fechar detalhe" title="Fechar (Esc)"><X size={18} aria-hidden="true" /></button>
      </div>
      {synthetic && <p className={`${styles.sectionNote} cell-detail`}><FlaskConical size={13} aria-hidden="true" /> Portas e ligações fictícias do demo.</p>}
      <dl className={styles.facts}>
        <dt>Estado</dt><dd>{STATUS[node.status].label}{node.critical ? ' · crítico' : ''}</dd>
        <dt>Última observação</dt><dd>{formatDate(node.lastObservedAt)}</dd>
        <dt>IP</dt><dd className="technical">{node.ip ?? '—'}</dd>
        <dt>MAC</dt><dd className="technical">{node.mac ?? '—'}</dd>
        <dt>A montante</dt><dd>{upstream.length ? upstream.map((edge) => `${graph.byId.get(edge.to)!.name}, ${linkLabel(edge)}; ${EVIDENCE[edge.evidence]}`).join(' · ')
          : node.group === 'unlinked' ? 'Sem ligação conhecida' : 'Raiz da fazenda'}</dd>
        <dt>A jusante</dt><dd>{downstream.length ? `${downstream.length} ${downstream.length === 1 ? 'equipamento' : 'equipamentos'}` : 'Nenhum'}</dd>
        {node.role === 'ap' && <><dt>Clientes</dt><dd>Não informado pela fonte de dados</dd></>}
        <dt>Uplink</dt><dd className="technical">{node.uplink ? `RX ${formatBps(node.uplink.rxBps)} · TX ${formatBps(node.uplink.txBps)}` : 'Sem amostra'}</dd>
      </dl>
      <div className={styles.trend}>
        {uplinkTrend.status === 'ready' && <Sparkline series={uplinkTrend.data} label="Uplink" />}
        {uplinkTrend.status === 'loading' && <span role="status">Carregando tráfego…</span>}
        {uplinkTrend.status === 'error' && <span role="status">{uplinkTrend.message}</span>}
        <span><i className={styles.keyRx} aria-hidden="true" />RX <i className={styles.keyTx} aria-hidden="true" />TX · 24 h</span>
      </div>
    </aside>
    <section className={`panel ${styles.portsPanel}`} aria-labelledby={`${headingId}-ports`}>
      <h2 id={`${headingId}-ports`} className={styles.sectionTitle}>Portas de {node.name}</h2>
      {vlan && carrying !== null && (
        <p className={styles.sectionNote}>{carrying ? `${carrying} ${carrying === 1 ? 'porta leva' : 'portas levam'} a VLAN ${vlanName({ vlanId: vlan.vlanId!, name: vlan.name })} (destacadas).`
          : `Nenhuma porta com VLAN ${vlan.vlanId} informada.`}</p>
      )}
      {!ports || ports.status === 'loading' ? <p className={styles.sectionNote} role="status">Carregando portas…</p>
        : ports.status === 'error' ? <p className={`message warning ${styles.sectionNote}`} role="status">{ports.message}</p>
        : ports.data.ports === null ? <EmptyState title="Portas não lidas">A fonte ainda não informou as portas deste equipamento.</EmptyState>
        : !ports.data.ports.length ? <EmptyState title="Sem portas">O equipamento foi lido e não tem portas.</EmptyState>
        : (
          <div className="table-container" role="region" tabIndex={0} aria-label={`Tabela de portas de ${node.name}`}>
            <table className={styles.portsTable}>
              <thead><tr><th scope="col">Porta</th><th scope="col">Estado</th><th scope="col">Velocidade</th><th scope="col">PoE</th>
                <th scope="col">VLAN nativa</th><th scope="col">VLANs marcadas</th><th scope="col">RX</th><th scope="col">TX</th><th scope="col">24 h</th></tr></thead>
              <tbody>{ports.data.ports.map((port) => {
                const highlighted = vlan?.vlanId !== null && vlan?.vlanId !== undefined && portCarriesVlan(port, vlan.vlanId);
                const unknownVlan = !port.nativeVlan && !port.taggedVlans.length;
                return (
                  <tr key={port.idx} data-vlan={highlighted || undefined}>
                    <th scope="row" className="technical">{port.idx}{port.name && port.name !== `Porta ${port.idx}` && <span className="cell-detail">{port.name}</span>}
                      {highlighted && <span className="visually-hidden"> (leva a VLAN filtrada)</span>}</th>
                    <td><span className={styles.portState} data-up={port.state === 'UP' || undefined}>{portState(port.state)}</span>{port.connector && <span className="cell-detail">{port.connector}</span>}</td>
                    <td className="technical">{formatSpeed(port.speedMbps)}{port.maxSpeedMbps !== null && <span className="cell-detail">máx. {formatSpeed(port.maxSpeedMbps)}</span>}</td>
                    <td>{poeText(port.poe)}</td>
                    <td>{port.nativeVlan ? <span className={highlighted && port.nativeVlan.vlanId === vlan?.vlanId ? styles.vlanTag : undefined}>{vlanName(port.nativeVlan)}</span>
                      : unknownVlan ? <span className="cell-detail">Não informada</span> : '—'}</td>
                    <td>{port.taggedVlans.length ? port.taggedVlans.map((tagged) => (
                      <span key={tagged.vlanId} className={tagged.vlanId === vlan?.vlanId ? styles.vlanTag : styles.tagged}>
                        {tagged.vlanId === vlan?.vlanId && <Tag size={12} aria-hidden="true" />}{vlanName(tagged)}</span>))
                      : '—'}</td>
                    <td className="technical">{formatBps(port.rxBps)}</td>
                    <td className="technical">{formatBps(port.txBps)}</td>
                    <td>{portTrends[port.idx] ? <Sparkline series={portTrends[port.idx]!} label={`Porta ${port.idx}`} /> : <span className="cell-detail">—</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      {portList && portList.length > 0 && portList.every((port) => port.rxBps === null) && (
        <p className={styles.sectionNote}>A fonte não expõe contadores por porta; o tráfego vem do uplink do equipamento.</p>
      )}
    </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- vista

export function TopologyView({ farms, farmId, online, demo }: { farms: DashboardFarm[]; farmId: string; online: boolean; demo: boolean }) {
  const [localFarm, setLocalFarm] = useState<string | null>(null);
  const currentFarm = farmId !== 'all' ? farmId : localFarm && farms.some((farm) => farm.id === localFarm) ? localFarm : farms[0]?.id ?? null;
  const farmName = farms.find((farm) => farm.id === currentFarm)?.name ?? '';
  const [topology, setTopology] = useState<Loaded<TopologyData> | null>(null);
  const [lastGood, setLastGood] = useState<TopologyData | null>(null);
  const [reload, setReload] = useState(0);
  const [vlans, setVlans] = useState<VlanSummaryItem[] | null>(null);
  const [vlanId, setVlanId] = useState<string>('');
  const [ports, setPorts] = useState<Record<string, Loaded<DevicePorts>>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    if (!currentFarm || !online) return;
    const controller = new AbortController();
    queueMicrotask(() => setTopology({ status: 'loading' }));
    requestJson<TopologyData>(`/api/network/topology?${new URLSearchParams({ farmId: currentFarm })}`, { signal: controller.signal })
      .then((data) => { setTopology({ status: 'ready', data }); setLastGood(data); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setTopology({ status: 'error', message: errorText(reason, 'Não foi possível carregar a topologia.') }); });
    requestJson<VlanSummary>(`/api/network/vlans?${new URLSearchParams({ farmId: currentFarm, limit: '200' })}`, { signal: controller.signal })
      .then((data) => setVlans(data.items))
      .catch(() => { if (!controller.signal.aborted) setVlans([]); });
    return () => controller.abort();
  }, [currentFarm, online, reload]);

  // Troca de fazenda: limpa seleção, filtro e portas carregadas da fazenda anterior.
  const [farmSeen, setFarmSeen] = useState(currentFarm);
  if (farmSeen !== currentFarm) {
    setFarmSeen(currentFarm);
    setSelectedId(null);
    setVlanId('');
    setVlans(null);
    setPorts({});
    setLastGood(null);
  }
  useEffect(() => { requested.current = new Set(); }, [currentFarm]);

  const data = topology?.status === 'ready' ? topology.data : lastGood?.farmId === currentFarm ? lastGood : null;
  const graph = useMemo(() => data ? buildGraph(data) : null, [data]);
  const selected = selectedId && graph?.byId.get(selectedId) ? graph.byId.get(selectedId)! : null;
  const vlan = vlans?.find((item) => item.id === vlanId) ?? null;

  const loadPorts = useCallback(async (ids: string[]) => {
    const pending = ids.filter((id) => !requested.current.has(id));
    pending.forEach((id) => requested.current.add(id));
    if (!pending.length) return;
    setPorts((current) => ({ ...current, ...Object.fromEntries(pending.map((id) => [id, { status: 'loading' } as const])) }));
    await pooled(pending, 4, async (id) => {
      try {
        const result = await requestJson<DevicePorts>(`/api/network/devices/${encodeURIComponent(id)}/ports`);
        setPorts((current) => ({ ...current, [id]: { status: 'ready', data: result } }));
      } catch (reason) {
        requested.current.delete(id);
        setPorts((current) => ({ ...current, [id]: { status: 'error', message: errorText(reason, 'Falha ao carregar as portas.') } }));
      }
    });
  }, []);

  useEffect(() => {
    if (selectedId && online) queueMicrotask(() => { void loadPorts([selectedId]); });
  }, [loadPorts, online, selectedId]);

  const vlanTargets = useMemo(() => graph && vlan ? graph.nodes.filter((node) => node.ports !== null).slice(0, VLAN_PORT_FETCH_LIMIT).map((node) => node.assetId) : [], [graph, vlan]);
  useEffect(() => {
    if (vlanTargets.length && online) queueMicrotask(() => { void loadPorts(vlanTargets); });
  }, [loadPorts, online, vlanTargets]);

  const vlanState = useMemo(() => {
    if (!graph || !vlan || vlan.vlanId === null) return null;
    const state = new Map<string, boolean | null>();
    for (const node of graph.nodes) {
      const loaded = ports[node.assetId];
      state.set(node.assetId, loaded?.status === 'ready' ? deviceCarriesVlan(loaded.data.ports, vlan.vlanId) : null);
    }
    return state;
  }, [graph, ports, vlan]);
  const vlanLoading = vlanTargets.some((id) => !ports[id] || ports[id]!.status === 'loading');
  const vlanCounts = vlanState ? [...vlanState.values()].reduce((sum, value) => ({
    yes: sum.yes + Number(value === true), no: sum.no + Number(value === false), unknown: sum.unknown + Number(value === null),
  }), { yes: 0, no: 0, unknown: 0 }) : null;

  if (!farms.length) return <EmptyState title="Nenhuma fazenda neste escopo">Cadastre uma fazenda para ver a topologia de rede.</EmptyState>;

  const latest = data ? latestObservation(data.nodes) : null;
  const stale = data ? isStale(latest, data.generatedAt) : false;
  const synthetic = demo || (data?.edges.some((edge) => edge.synthetic) ?? false);
  const vlanOptions = (vlans ?? []).filter((item) => item.vlanId !== null);
  const title = `Topologia de rede da ${farmName}`;

  return (
    <div className="content-stack">
      <div className={styles.toolbar}>
        {farmId === 'all' && (
          <label className="filter-field">Fazenda
            <select value={currentFarm ?? ''} onChange={(event) => setLocalFarm(event.target.value)}>
              {farms.map((farm) => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
            </select>
          </label>
        )}
        <label className="filter-field">Destacar VLAN
          <select value={vlanId} onChange={(event) => setVlanId(event.target.value)} disabled={!vlanOptions.length}>
            <option value="">{vlans === null ? 'Carregando VLANs…' : vlanOptions.length ? 'Nenhuma' : 'Nenhuma VLAN lida nesta fazenda'}</option>
            {vlanOptions.map((item) => <option key={item.id} value={item.id}>{vlanName({ vlanId: item.vlanId!, name: item.name })}{item.enabled === false ? ' (desativada)' : ''}</option>)}
          </select>
        </label>
        <div className={styles.toolbarActions}>
          <button type="button" className={`button secondary ${styles.toggle}`} aria-pressed={showTable} onClick={() => setShowTable((value) => !value)}>
            {showTable ? <ChartNetwork size={16} aria-hidden="true" /> : <Table2 size={16} aria-hidden="true" />} {showTable ? 'Ver grafo' : 'Ver tabela'}
          </button>
          <button type="button" className="button icon-button" onClick={() => setReload((value) => value + 1)} disabled={!online || topology?.status === 'loading'}
            aria-label="Atualizar topologia" title="Atualizar topologia"><RefreshCw size={18} className={topology?.status === 'loading' ? 'spin' : undefined} aria-hidden="true" /></button>
        </div>
      </div>
      <p className={`cell-detail ${styles.toolbarNote}`} aria-live="polite">
        {vlanCounts ? (vlanLoading ? 'Lendo as portas para o filtro de VLAN…'
          : `${vlanCounts.yes} ${vlanCounts.yes === 1 ? 'equipamento leva' : 'equipamentos levam'} a VLAN ${vlan?.vlanId}; ${vlanCounts.no} não; ${vlanCounts.unknown} sem VLAN por porta informada.`)
          : data ? `${wholeNumber.format(data.nodes.length)} ${data.nodes.length === 1 ? 'equipamento' : 'equipamentos'}, ${wholeNumber.format(graph?.edges.length ?? 0)} ${graph?.edges.length === 1 ? 'ligação' : 'ligações'}. Consultado em ${formatDate(data.generatedAt)}.` : ''}
      </p>

      {topology?.status === 'error' && (
        <p className="message warning" role="status">{topology.message}{data ? ' Exibindo a última consulta.' : ''}
          <button type="button" className="button secondary" onClick={() => setReload((value) => value + 1)} disabled={!online}>Tentar de novo</button></p>
      )}
      {!online && !data && <p className="message warning" role="status">Sem conexão: a topologia aparece quando a rede voltar.</p>}
      {data?.truncated && <p className="message warning" role="status">A fazenda tem mais equipamentos do que o limite do desenho; só os primeiros {wholeNumber.format(data.nodes.length)} aparecem.</p>}
      {stale && <p className="message warning" role="status">A observação mais recente é de {formatDate(latest)}. O desenho pode estar desatualizado.</p>}

      {!data ? (topology?.status === 'loading' || topology === null ? <p className="cell-detail" role="status">Carregando topologia…</p> : null)
        : !graph || !graph.nodes.length ? (
          <section className="panel"><EmptyState title="Nenhum equipamento de rede nesta fazenda">
            Os equipamentos aparecem quando o coletor UniFi enviar a primeira captura com portas ou uplink.</EmptyState></section>
        ) : (
          <div className={styles.layout} data-detail={selected ? '' : undefined}>
            <section className="panel" aria-label={title} aria-busy={topology?.status === 'loading'}>
              <div className="panel-heading">
                <div><h2>{farmName}</h2>
                  <p>Hierarquia lógica a partir do uplink de cada equipamento. Só há ligação desenhada quando existe evidência.</p></div>
                {synthetic && <span className="demo-label"><FlaskConical size={15} aria-hidden="true" /> Dados fictícios</span>}
              </div>
              {!showTable && (
                <div className={styles.legend} aria-label="Legenda">
                  {(Object.keys(STATUS) as Array<keyof typeof STATUS>).map((key) => {
                    const Icon = STATUS[key].icon;
                    return <span key={key} className={styles.legendItem}><i className={styles.legendDot} data-status={key} aria-hidden="true" /><Icon size={13} aria-hidden="true" />{STATUS[key].label}</span>;
                  })}
                  <span className={styles.legendItem}><svg width="28" height="8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" className={styles.edge} data-level="port" /></svg>Porta a porta (duas portas identificadas)</span>
                  <span className={styles.legendItem}><svg width="28" height="8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" className={styles.edge} data-level="device" /></svg>Entre dispositivos (sem evidência das portas)</span>
                  <span className={styles.legendItem}><Star size={13} aria-hidden="true" className={styles.criticalMark} />Crítico</span>
                  {vlanState && <span className={styles.legendItem}><svg width="14" height="14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" rx="3" fill="none" stroke="var(--wheat)" strokeWidth="2" /></svg>Leva a VLAN; esmaecidos não levam ou não informam</span>}
                </div>
              )}
              {showTable ? <GraphTables graph={graph} onSelect={setSelectedId} />
                : <TopologyCanvas graph={graph} title={title} selectedId={selected?.assetId ?? null} vlanState={vlanState} onSelect={setSelectedId} />}
            </section>
            {selected && currentFarm && (
              <NodeDetail key={selected.assetId} node={selected} graph={graph} farmId={currentFarm} ports={ports[selected.assetId]} vlan={vlan} online={online}
                onClose={() => setSelectedId(null)} />
            )}
          </div>
        )}
    </div>
  );
}
