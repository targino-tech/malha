/**
 * Regras do grafo de topologia lógica (sem React): normaliza a evidência das ligações, escolhe o uplink que
 * posiciona cada nó, quebra ciclos e calcula um desenho hierárquico gateway → switches → APs.
 *
 * Nada aqui cria ligação: toda aresta desenhada vem de `Topology.edges`. Nós sem nenhuma ligação ficam num grupo
 * à parte ("sem ligação conhecida"), em vez de serem pendurados no gateway por suposição.
 */
import type { DevicePort, DeviceRole, Topology, TopologyEdge, TopologyNode } from '../../server/network/types';

export const NODE_WIDTH = 212;
export const NODE_HEIGHT = 64;
const COLUMN = NODE_WIDTH + 28;
const ROW = NODE_HEIGHT + 84;
const UNLINKED_GAP = 72;

/** Ligação já validada. `portToPort` só é verdadeiro quando a evidência identifica as duas portas. */
export type GraphEdge = {
  id: string;
  /** Dispositivo a jusante (o que aponta o uplink). */
  from: string;
  /** Dispositivo a montante. */
  to: string;
  portToPort: boolean;
  fromPortIdx: number | null;
  toPortIdx: number | null;
  evidence: TopologyEdge['evidence'];
  synthetic: boolean;
  lastSeenAt: string;
  /** Verdadeiro quando esta é a ligação usada para posicionar o nó a jusante na hierarquia. */
  primary: boolean;
};

export type GraphNode = TopologyNode & {
  x: number;
  y: number;
  depth: number;
  /** Nó a montante pela ligação primária; nulo nas raízes e nos nós sem ligação. */
  parent: string | null;
  children: string[];
  /** `tree` quando o nó participa de pelo menos uma ligação; `unlinked` quando nenhuma evidência o liga a outro. */
  group: 'tree' | 'unlinked';
};

export type TopologyGraph = {
  nodes: GraphNode[];
  byId: Map<string, GraphNode>;
  edges: GraphEdge[];
  roots: string[];
  unlinked: string[];
  bounds: { width: number; height: number };
  /** Linha (y) onde começa o grupo de nós sem ligação, para o rótulo do grupo. */
  unlinkedTop: number | null;
};

const ROLE_ORDER: Record<DeviceRole, number> = { gateway: 0, switch: 1, radio: 2, ap: 3, other: 4 };
const EVIDENCE_ORDER: Record<TopologyEdge['evidence'], number> = { lldp: 0, unifi_uplink: 1, synthetic: 2 };

const byRoleThenName = (a: TopologyNode, b: TopologyNode) =>
  ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name, 'pt-BR') || a.assetId.localeCompare(b.assetId);

/** Porta a porta só com nível `port` e as duas portas preenchidas; qualquer outra combinação vira ligação entre dispositivos. */
export function isPortToPort(edge: Pick<TopologyEdge, 'level' | 'fromPortIdx' | 'toPortIdx'>) {
  return edge.level === 'port' && Number.isInteger(edge.fromPortIdx) && Number.isInteger(edge.toPortIdx);
}

/** Ordem de preferência entre ligações do mesmo par ou do mesmo nó: porta a porta, depois evidência, depois a mais recente. */
function stronger(a: GraphEdge, b: GraphEdge) {
  return Number(b.portToPort) - Number(a.portToPort)
    || EVIDENCE_ORDER[a.evidence] - EVIDENCE_ORDER[b.evidence]
    || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)
    || a.to.localeCompare(b.to);
}

/** Valida, normaliza e deduplica as ligações. Descarta laços e pontas fora da lista de nós. */
export function normalizeEdges(topology: Pick<Topology, 'nodes' | 'edges'>): GraphEdge[] {
  const ids = new Set(topology.nodes.map((node) => node.assetId));
  const pairs = new Map<string, GraphEdge>();
  for (const edge of topology.edges) {
    if (edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to)) continue;
    const portToPort = isPortToPort(edge);
    const candidate: GraphEdge = {
      id: `${edge.from}>${edge.to}`, from: edge.from, to: edge.to, portToPort,
      fromPortIdx: portToPort ? edge.fromPortIdx : null, toPortIdx: portToPort ? edge.toPortIdx : null,
      evidence: edge.evidence, synthetic: edge.synthetic, lastSeenAt: edge.lastSeenAt, primary: false,
    };
    // Par invertido (A→B e B→A) é a mesma ligação física: fica uma só, a de evidência mais forte.
    const key = [edge.from, edge.to].sort().join('|');
    const current = pairs.get(key);
    if (!current || stronger(candidate, current) < 0) pairs.set(key, candidate);
  }
  return [...pairs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Monta o grafo e o desenho hierárquico. Determinístico para a mesma entrada. */
export function buildGraph(topology: Pick<Topology, 'nodes' | 'edges'>): TopologyGraph {
  const edges = normalizeEdges(topology);
  const source = [...topology.nodes].sort(byRoleThenName);
  const byId = new Map<string, GraphNode>(source.map((node) => [node.assetId, {
    ...node, x: 0, y: 0, depth: 0, parent: null, children: [], group: 'unlinked',
  }]));
  for (const edge of edges) {
    byId.get(edge.from)!.group = 'tree';
    byId.get(edge.to)!.group = 'tree';
  }

  // Ligação primária: a mais forte entre as que saem do nó, desde que não feche um ciclo.
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  const reaches = (start: string, target: string) => {
    for (let cursor: string | null = start, steps = 0; cursor && steps <= byId.size; cursor = byId.get(cursor)!.parent, steps += 1) {
      if (cursor === target) return true;
    }
    return false;
  };
  for (const node of source) {
    for (const edge of (outgoing.get(node.assetId) ?? []).sort(stronger)) {
      if (reaches(edge.to, edge.from)) continue;
      edge.primary = true;
      byId.get(edge.from)!.parent = edge.to;
      break;
    }
  }
  for (const node of source) {
    const current = byId.get(node.assetId)!;
    if (current.parent) byId.get(current.parent)!.children.push(current.assetId);
  }
  for (const node of byId.values()) node.children.sort((a, b) => byRoleThenName(byId.get(a)!, byId.get(b)!));

  const roots = source.filter((node) => byId.get(node.assetId)!.group === 'tree' && !byId.get(node.assetId)!.parent).map((node) => node.assetId);
  const unlinked = source.filter((node) => byId.get(node.assetId)!.group === 'unlinked').map((node) => node.assetId);

  // Desenho: cada folha ocupa uma coluna; o nó pai fica no centro dos filhos.
  let slot = 0;
  let maxDepth = 0;
  const place = (id: string, depth: number): number => {
    const node = byId.get(id)!;
    node.depth = depth;
    node.y = depth * ROW;
    maxDepth = Math.max(maxDepth, depth);
    if (!node.children.length) {
      node.x = slot * COLUMN;
      slot += 1;
      return node.x;
    }
    const xs = node.children.map((child) => place(child, depth + 1));
    node.x = (xs[0]! + xs.at(-1)!) / 2;
    return node.x;
  };
  for (const root of roots) place(root, 0);

  const treeColumns = Math.max(slot, 1);
  let unlinkedTop: number | null = null;
  if (unlinked.length) {
    unlinkedTop = roots.length ? maxDepth * ROW + NODE_HEIGHT + UNLINKED_GAP : 0;
    const perRow = Math.max(4, Math.min(treeColumns, 8));
    unlinked.forEach((id, index) => {
      const node = byId.get(id)!;
      node.x = (index % perRow) * COLUMN;
      node.y = unlinkedTop! + 28 + Math.floor(index / perRow) * (NODE_HEIGHT + 28);
    });
  }

  const nodes = [...byId.values()];
  const width = Math.max(...nodes.map((node) => node.x + NODE_WIDTH), NODE_WIDTH);
  const height = Math.max(...nodes.map((node) => node.y + NODE_HEIGHT), NODE_HEIGHT);
  return { nodes, byId, edges, roots, unlinked, bounds: { width, height }, unlinkedTop };
}

/** Ordem de leitura do grafo (em profundidade, raízes primeiro e depois os nós sem ligação). */
export function readingOrder(graph: TopologyGraph): string[] {
  const order: string[] = [];
  const visit = (id: string) => { order.push(id); for (const child of graph.byId.get(id)!.children) visit(child); };
  for (const root of graph.roots) visit(root);
  return [...order, ...graph.unlinked];
}

/** Navegação por teclado: ↑ montante, ↓ primeiro a jusante, ←/→ irmãos (ou vizinho na ordem de leitura), Home/End. */
export function navigate(graph: TopologyGraph, currentId: string, key: string): string | null {
  const node = graph.byId.get(currentId);
  if (!node) return null;
  const order = readingOrder(graph);
  if (key === 'Home') return order[0] ?? null;
  if (key === 'End') return order.at(-1) ?? null;
  if (key === 'ArrowUp') return node.parent;
  if (key === 'ArrowDown') return node.children[0] ?? null;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const siblings = node.parent ? graph.byId.get(node.parent)!.children : node.group === 'tree' ? graph.roots : graph.unlinked;
  const index = siblings.indexOf(currentId);
  const next = siblings[index + (key === 'ArrowRight' ? 1 : -1)];
  if (next) return next;
  const position = order.indexOf(currentId);
  return order[position + (key === 'ArrowRight' ? 1 : -1)] ?? null;
}

/** A porta leva a VLAN como nativa ou marcada. Portas cuja fonte não informa VLAN nunca casam. */
export function portCarriesVlan(port: Pick<DevicePort, 'nativeVlan' | 'taggedVlans'>, vlanId: number) {
  return port.nativeVlan?.vlanId === vlanId || port.taggedVlans.some((vlan) => vlan.vlanId === vlanId);
}

/**
 * Para o filtro de VLAN: `true` quando alguma porta lida leva a VLAN, `false` quando as portas foram lidas e
 * nenhuma leva, `null` quando não há como saber (portas nunca lidas ou fonte sem VLAN por porta).
 */
export function deviceCarriesVlan(ports: DevicePort[] | null | undefined, vlanId: number): boolean | null {
  if (!ports) return null;
  if (ports.some((port) => portCarriesVlan(port, vlanId))) return true;
  return ports.some((port) => port.nativeVlan || port.taggedVlans.length) ? false : null;
}

/** Observação mais recente entre os nós; o painel considera o desenho desatualizado acima de 15 minutos. */
export function latestObservation(nodes: Array<Pick<TopologyNode, 'lastObservedAt'>>): string | null {
  let latest: number | null = null;
  for (const node of nodes) {
    const value = node.lastObservedAt ? Date.parse(node.lastObservedAt) : NaN;
    if (Number.isFinite(value) && (latest === null || value > latest)) latest = value;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export const STALE_AFTER_MS = 15 * 60 * 1000;

export function isStale(latest: string | null, now: string) {
  return latest !== null && Date.parse(now) - Date.parse(latest) > STALE_AFTER_MS;
}

const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/** Taxa em bits por segundo no padrão brasileiro (`12,5 Mbit/s`). Nulo vira travessão: não lido não é zero. */
export function formatBps(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const units = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s', 'Tbit/s'];
  let scaled = Math.max(0, value);
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) { scaled /= 1000; unit += 1; }
  return `${decimal.format(scaled)} ${units[unit]}`;
}

export function formatSpeed(mbps: number | null) {
  if (mbps === null) return '—';
  return mbps >= 1000 ? `${decimal.format(mbps / 1000)} Gbit/s` : `${decimal.format(mbps)} Mbit/s`;
}

/** Curva da aresta: sai da base do nó a montante e chega ao topo do nó a jusante. */
export function edgePath(upstream: Pick<GraphNode, 'x' | 'y'>, downstream: Pick<GraphNode, 'x' | 'y'>) {
  const x1 = upstream.x + NODE_WIDTH / 2;
  const y1 = upstream.y + NODE_HEIGHT;
  const x2 = downstream.x + NODE_WIDTH / 2;
  const y2 = downstream.y;
  if (y2 <= y1) {
    // Ligação extra que sobe ou fica no mesmo nível: arco lateral para não cruzar os nós.
    const lift = Math.max(40, Math.abs(x2 - x1) / 3);
    return `M ${x1} ${upstream.y} C ${x1} ${upstream.y - lift}, ${x2} ${downstream.y - lift}, ${x2} ${y2}`;
  }
  const middle = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`;
}
