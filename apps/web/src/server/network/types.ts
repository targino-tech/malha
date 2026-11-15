/**
 * Contrato das rotas GET em /api/network/*. Tipos compartilhados entre o servidor e os componentes do painel.
 * Documentação completa em docs/rede.md. Campos novos entram sempre como opcionais ou anuláveis.
 */

export type DeviceRole = 'gateway' | 'switch' | 'ap' | 'radio' | 'other';
export type AssetStatus = 'online' | 'offline' | 'unknown';
/** De onde veio a ligação: uplink informado pelo UniFi, vizinhança LLDP ou dado fictício do demo. */
export type LinkEvidence = 'unifi_uplink' | 'lldp' | 'synthetic';
/** 'port' só quando a evidência identifica as duas portas; caso contrário a ligação é entre dispositivos. */
export type LinkLevel = 'device' | 'port';
export type TrafficPeriod = '24h' | '7d' | '30d';
export type TrafficSource = 'unifi_rate' | 'counter_delta' | 'synthetic';

export type TopologyNode = {
  assetId: string;
  name: string;
  role: DeviceRole;
  /** Fabricante pelo catálogo (`server/catalog.ts`), ou nulo quando não identificado. */
  vendor: string | null;
  model: string | null;
  ip: string | null;
  mac: string | null;
  status: AssetStatus;
  critical: boolean;
  lastObservedAt: string | null;
  /** Portas conhecidas e quantas estão com enlace ativo. Nulo quando as portas nunca foram lidas. */
  ports: { total: number; up: number } | null;
  /** Última taxa de uplink observada (bits por segundo). */
  uplink: { rxBps: number; txBps: number; observedAt: string } | null;
};

export type TopologyEdge = {
  /** Dispositivo que aponta o uplink (a jusante). */
  from: string;
  /** Dispositivo a montante. */
  to: string;
  level: LinkLevel;
  evidence: LinkEvidence;
  fromPortIdx: number | null;
  toPortIdx: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  synthetic: boolean;
};

export type Topology = {
  farmId: string;
  generatedAt: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** Verdadeiro quando o número de nós atingiu o limite e a resposta foi truncada. */
  truncated: boolean;
};

export type DevicePort = {
  idx: number;
  name: string | null;
  state: string;
  connector: string | null;
  speedMbps: number | null;
  maxSpeedMbps: number | null;
  poe: { standard: string | null; enabled: boolean | null; state: string | null; powerMw: number | null } | null;
  nativeVlan: { vlanId: number; name: string | null } | null;
  taggedVlans: Array<{ vlanId: number; name: string | null }>;
  /** Taxa mais recente derivada de contadores. Nula quando a fonte não expõe contadores por porta. */
  rxBps: number | null;
  txBps: number | null;
  counters: {
    rxBytes: number | null; txBytes: number | null; rxPackets: number | null; txPackets: number | null;
    rxErrors: number | null; txErrors: number | null; rxDropped: number | null; txDropped: number | null;
  } | null;
  observedAt: string;
  synthetic: boolean;
};

export type DevicePorts = {
  assetId: string;
  farmId: string;
  name: string;
  role: DeviceRole;
  /** Nulo quando as portas deste dispositivo nunca foram lidas; lista vazia quando ele não tem portas. */
  ports: DevicePort[] | null;
};

export type VlanSummaryItem = {
  farmId: string;
  farmName: string;
  id: string;
  name: string;
  vlanId: number | null;
  subnet: string | null;
  enabled: boolean | null;
  management: string | null;
  /** Portas com esta VLAN nativa ou marcada (só conta portas cujas VLANs a fonte informa). */
  nativePorts: number;
  taggedPorts: number;
  observedAt: string;
  synthetic: boolean;
};

export type VlanSummary = { items: VlanSummaryItem[]; total: number; nextCursor: string | null };

export type TrafficPoint = {
  /** Início do intervalo (ISO 8601, UTC). */
  t: string;
  rxBps: number;
  txBps: number;
  rxMaxBps: number;
  txMaxBps: number;
  /** Volume estimado no intervalo, em bytes. */
  rxBytes: number;
  txBytes: number;
  samples: number;
};

export type TrafficSeries = {
  scope: { farmId: string; assetId: string | null; portIdx: number | null; kind: 'farm' | 'uplink' | 'port' };
  from: string;
  to: string;
  bucketSeconds: number;
  sources: TrafficSource[];
  points: TrafficPoint[];
};

export type GeoFarm = {
  farmId: string;
  name: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  metrics: {
    trafficRxBytes: number;
    trafficTxBytes: number;
    offlineAssets: number;
    assets: number;
    openOccurrences: number;
    collector: { captures: number; batches: number; payloadBytes: number; lastCaptureAt: string | null } | null;
  };
  synthetic: boolean;
};

export type Geo = { period: TrafficPeriod; from: string; to: string; farms: GeoFarm[] };
