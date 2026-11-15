/**
 * Catálogo do parque tecnológico: classifica cada ativo em uma família e detecta o fabricante a partir
 * do texto que a TI já cadastra (categoria, nome e modelo). É a mesma base usada para montar
 * monitoramento externo (Zabbix, Grafana), então a ordem das regras importa: a primeira que casar vence.
 */
export const FAMILIES = [
  { id: 'core', label: 'Núcleo e roteamento', short: 'Núcleo', keywords: ['switch', 'roteador', 'router', 'gateway', 'firewall', 'core', 'udm', 'usg', 'fortigate', 'mikrotik'] },
  { id: 'wifi', label: 'Acesso Wi-Fi', short: 'Wi-Fi', keywords: ['ponto de acesso', 'access point', 'wi-fi', 'wifi', 'wireless'], tokens: ['ap', 'uap'] },
  { id: 'radio', label: 'Enlaces de rádio', short: 'Rádio', keywords: ['radio', 'enlace', 'ptp', 'ptmp', 'airmax', 'airfiber', 'antena', 'litebeam', 'powerbeam', 'nanostation'] },
  { id: 'identity', label: 'Controladores de domínio', short: 'Domínio', keywords: ['controlador de dominio', 'domain controller', 'active directory'], tokens: ['dc', 'ad'] },
  { id: 'servers', label: 'Servidores', short: 'Servidores', keywords: ['servidor', 'server', 'storage', 'hypervisor', 'esxi', 'proxmox', 'nas'] },
  { id: 'endpoints', label: 'Estações de usuário', short: 'Estações', keywords: ['estacao', 'desktop', 'notebook', 'computador', 'workstation', 'laptop', 'impressora', 'printer'], tokens: ['pc'] },
  { id: 'field', label: 'Equipamentos de campo', short: 'Campo', keywords: ['balanca', 'sensor', 'clp', 'plc', 'telemetria', 'iot', 'tablet', 'coletor de dados', 'estacao meteorologica', 'pivo'] },
  { id: 'security', label: 'Segurança física', short: 'Segurança', keywords: ['camera', 'cftv', 'dvr', 'nvr', 'controle de acesso', 'catraca'] },
] as const;

export type FamilyId = (typeof FAMILIES)[number]['id'] | 'other';
export const OTHER_FAMILY = { id: 'other' as const, label: 'Outros', short: 'Outros' };

export const VENDORS = [
  { id: 'cisco', label: 'Cisco', keywords: ['cisco', 'catalyst', 'meraki', 'nexus'] },
  { id: 'huawei', label: 'Huawei', keywords: ['huawei', 'cloudengine'] },
  { id: 'ubiquiti', label: 'Ubiquiti', keywords: ['ubiquiti', 'unifi', 'airmax', 'airfiber', 'edgerouter', 'litebeam', 'powerbeam', 'nanostation', 'uap', 'usw', 'udm', 'usg'] },
  { id: 'mikrotik', label: 'MikroTik', keywords: ['mikrotik', 'routeros', 'routerboard'] },
  { id: 'fortinet', label: 'Fortinet', keywords: ['fortinet', 'fortigate'] },
  { id: 'aruba', label: 'HPE Aruba', keywords: ['aruba', 'procurve'] },
  { id: 'intelbras', label: 'Intelbras', keywords: ['intelbras'] },
  { id: 'tplink', label: 'TP-Link', keywords: ['tp-link', 'tplink', 'omada'] },
  { id: 'windows', label: 'Microsoft Windows', keywords: ['windows'] },
  { id: 'linux', label: 'Linux', keywords: ['linux', 'ubuntu', 'debian', 'red hat', 'rhel'] },
] as const;

export type VendorId = (typeof VENDORS)[number]['id'];

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function matches(text: string, words: string[], keywords: readonly string[], tokens: readonly string[] = []) {
  return keywords.some((keyword) => text.includes(keyword)) || tokens.some((token) => words.includes(token));
}

export function classify(asset: { category?: string | null; name?: string | null; model?: string | null }) {
  const categoryText = normalize(asset.category ?? '');
  const fullText = normalize([asset.category, asset.name, asset.model].filter(Boolean).join(' '));
  const words = fullText.split(/[^a-z0-9]+/).filter(Boolean);
  const categoryWords = categoryText.split(/[^a-z0-9]+/).filter(Boolean);
  // A categoria decide primeiro; nome e modelo só desempatam quando ela não diz nada.
  const family = FAMILIES.find((item) => matches(categoryText, categoryWords, item.keywords, 'tokens' in item ? item.tokens : []))
    ?? FAMILIES.find((item) => matches(fullText, words, item.keywords, 'tokens' in item ? item.tokens : []));
  const vendor = VENDORS.find((item) => matches(fullText, words, item.keywords));
  return { family: (family?.id ?? 'other') as FamilyId, vendor: (vendor?.id ?? null) as VendorId | null };
}

export function familyLabel(id: FamilyId) {
  return FAMILIES.find((item) => item.id === id)?.label ?? OTHER_FAMILY.label;
}
