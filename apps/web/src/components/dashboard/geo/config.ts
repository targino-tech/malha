/**
 * Configuração do mapa base (tiles, glifos e sprites) e as origens que a CSP do painel precisa liberar.
 *
 * - `NEXT_PUBLIC_MAP_STYLE_URL`: URL do estilo MapLibre. Padrão: estilo escuro do OpenFreeMap (dados do
 *   OpenStreetMap, sem chave). `none` desliga o mapa base: as fazendas aparecem sobre um fundo liso, sem
 *   nenhuma requisição externa. Caminho relativo (`/mapa/estilo.json`) usa o próprio Malha. Só https é aceito
 *   para estilo externo. Como toda variável `NEXT_PUBLIC_*`, é fixada no build.
 * - `MALHA_MAP_EXTRA_ORIGINS`: origens adicionais (separadas por vírgula, só `https://host[:porta]`) que o estilo
 *   referencia em outro host, como tiles ou glifos de um CDN. Lida em tempo de execução, só pelo servidor.
 */
export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

export type MapStyleConfig =
  | { kind: 'remote'; url: string; origin: string }
  | { kind: 'local'; url: string }
  | { kind: 'none' };

export function resolveMapStyle(raw: string | undefined = process.env.NEXT_PUBLIC_MAP_STYLE_URL): MapStyleConfig {
  const value = raw?.trim();
  if (value === undefined || value === '') return resolveMapStyle(DEFAULT_MAP_STYLE_URL);
  if (value.toLowerCase() === 'none') return { kind: 'none' };
  if (value.startsWith('/') && !value.startsWith('//')) return { kind: 'local', url: value };
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return { kind: 'none' };
    return { kind: 'remote', url: url.href, origin: url.origin };
  } catch {
    return { kind: 'none' };
  }
}

/** Aceita só origens https exatas (sem caminho, curinga, usuário ou parâmetros). Inválidas são ignoradas. */
export function parseExtraOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins = new Set<string>();
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value || value.includes('*')) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) continue;
      if (value.replace(/\/$/, '') !== url.origin) continue;
      origins.add(url.origin);
    } catch {
      // Valor inválido: fica fora da política.
    }
  }
  return [...origins];
}

/** Origens externas que o painel precisa em connect-src e img-src para desenhar o mapa base. */
export function mapCspOrigins(
  style: MapStyleConfig = resolveMapStyle(),
  extra: string | undefined = process.env.MALHA_MAP_EXTRA_ORIGINS,
): string[] {
  if (style.kind === 'none') return [];
  const origins = new Set(parseExtraOrigins(extra));
  if (style.kind === 'remote') origins.add(style.origin);
  return [...origins];
}

export const OSM_ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© colaboradores do OpenStreetMap</a>';
