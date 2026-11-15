import { ASSET_FROM, ASSET_STATUS } from './assets';
import { requireFarm } from './authz';
import { classify, FAMILIES, OTHER_FAMILY, type FamilyId, type VendorId } from './catalog';
import { setOrg, type Database } from './db';
import { HttpError, uuidPattern } from './http';
import type { Principal } from './identity';

export type AssetState = 'online' | 'offline' | 'unknown' | 'manual';

export type Charts = {
  periodDays: number;
  timezone: string;
  assetStates: Array<{ farmId: string; name: string } & Record<AssetState, number>>;
  occurrencesByDay: Array<{ day: string; critical: number; warning: number }>;
  availability: Array<{ farmId: string; name: string; silentMinutes: number; ratio: number }>;
  categories: Array<{ category: string; total: number }>;
  families: Array<{ family: FamilyId; label: string; vendors: Array<{ vendor: VendorId; total: number }> } & Record<AssetState, number>>;
};

const TIMEZONE = 'America/Cuiaba';
const CATEGORY_LIMIT = 6;

/**
 * Dados dos gráficos do painel. Toda consulta roda com o grupo fixado (RLS) e filtra pelas fazendas
 * que o usuário acessa; um `farmId` explícito precisa estar nesse escopo.
 */
export async function charts(database: Database, user: Principal, params: URLSearchParams): Promise<Charts> {
  const days = Number(params.get('days') ?? 30);
  if (![7, 30, 90].includes(days)) throw new HttpError(400, 'Período inválido.');
  const farmParam = params.get('farmId');
  if (farmParam) {
    if (!uuidPattern.test(farmParam)) throw new HttpError(404, 'Fazenda indisponível.');
    requireFarm(user, farmParam);
  }
  const farmIds = farmParam ? [farmParam] : user.farmIds;
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    // Um administrador enxerga todas as fazendas do grupo, mas o id informado precisa ser de uma delas.
    if (farmParam) {
      const { rows } = await tx.query('SELECT 1 FROM farms WHERE org_id = $1 AND id = $2', [user.orgId, farmParam]);
      if (!rows.length) throw new HttpError(404, 'Fazenda indisponível.');
    }
    const scope = [user.orgId, farmIds];

    // Estado atual por fazenda. Ativo sem nenhuma observação é cadastro manual, sem telemetria.
    const { rows: states } = await tx.query<{ farm_id: string; name: string; state: AssetState; total: string }>(`
      SELECT f.id AS farm_id, f.name,
        CASE WHEN a.id IS NULL THEN NULL WHEN a.last_observed_at IS NULL THEN 'manual' ELSE ${ASSET_STATUS} END AS state,
        count(a.id) AS total
      FROM farms f
      LEFT JOIN (${ASSET_FROM}) ON a.org_id = f.org_id AND a.farm_id = f.id AND a.archived_at IS NULL
      WHERE f.org_id = $1 AND ($2::uuid[] IS NULL OR f.id = ANY($2::uuid[]))
      GROUP BY 1, 2, 3 ORDER BY f.name`, scope);
    const byFarm = new Map<string, Charts['assetStates'][number]>();
    for (const row of states) {
      const entry = byFarm.get(row.farm_id) ?? { farmId: row.farm_id, name: row.name, online: 0, offline: 0, unknown: 0, manual: 0 };
      if (row.state) entry[row.state === 'online' || row.state === 'offline' || row.state === 'manual' ? row.state : 'unknown'] += Number(row.total);
      byFarm.set(row.farm_id, entry);
    }

    // Ocorrências abertas por dia, no fuso de Cuiabá, separadas por severidade.
    const { rows: daily } = await tx.query<{ day: string; critical: string; warning: string }>(`
      WITH series AS (
        SELECT generate_series((now() AT TIME ZONE '${TIMEZONE}')::date - ($3::int - 1), (now() AT TIME ZONE '${TIMEZONE}')::date, interval '1 day')::date AS day
      )
      SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
        count(o.id) FILTER (WHERE o.severity = 'critical') AS critical,
        count(o.id) FILTER (WHERE o.severity = 'warning') AS warning
      FROM series s
      LEFT JOIN occurrences o ON (o.opened_at AT TIME ZONE '${TIMEZONE}')::date = s.day
        AND o.org_id = $1 AND ($2::uuid[] IS NULL OR o.farm_id = ANY($2::uuid[]))
      GROUP BY s.day ORDER BY s.day`, [...scope, days]);

    // Disponibilidade: fração do período em que cada coletor ativo não ficou sem contato.
    // Usa os episódios de "coletor sem contato" recortados ao período, do último sinal até o encerramento.
    const { rows: availability } = await tx.query<{ farm_id: string; name: string; silent_seconds: string | null }>(`
      SELECT f.id AS farm_id, f.name,
        sum(greatest(0, extract(epoch FROM least(coalesce(o.resolved_at, now()), now())
          - greatest(coalesce(o.first_observed_at, o.opened_at), now() - make_interval(days => $3))))) AS silent_seconds
      FROM farms f
      JOIN collector_keys k ON k.org_id = f.org_id AND k.farm_id = f.id AND k.revoked_at IS NULL
      LEFT JOIN occurrences o ON o.org_id = f.org_id AND o.farm_id = f.id AND o.rule = 'collector_silent'
        AND coalesce(o.resolved_at, now()) >= now() - make_interval(days => $3)
      WHERE f.org_id = $1 AND ($2::uuid[] IS NULL OR f.id = ANY($2::uuid[]))
      GROUP BY 1, 2 ORDER BY f.name`, [...scope, days]);
    const periodSeconds = days * 86_400;

    // Famílias do parque: o estado de cada ativo agregado pela classificação do catálogo.
    const { rows: assets } = await tx.query<{ category: string; name: string; model: string | null; state: AssetState }>(`
      SELECT a.category, a.name, a.model,
        CASE WHEN a.last_observed_at IS NULL THEN 'manual' ELSE ${ASSET_STATUS} END AS state
      FROM ${ASSET_FROM}
      WHERE a.org_id = $1 AND ($2::uuid[] IS NULL OR a.farm_id = ANY($2::uuid[])) AND a.archived_at IS NULL`, scope);
    const families = new Map<FamilyId, Charts['families'][number]>();
    for (const item of [...FAMILIES, OTHER_FAMILY]) {
      families.set(item.id, { family: item.id, label: item.label, vendors: [], online: 0, offline: 0, unknown: 0, manual: 0 });
    }
    for (const asset of assets) {
      const { family, vendor } = classify(asset);
      const entry = families.get(family)!;
      const state = asset.state === 'online' || asset.state === 'offline' || asset.state === 'manual' ? asset.state : 'unknown';
      entry[state] += 1;
      if (vendor) {
        const found = entry.vendors.find((item) => item.vendor === vendor);
        if (found) found.total += 1; else entry.vendors.push({ vendor, total: 1 });
      }
    }

    const { rows: categories } = await tx.query<{ category: string; total: string }>(`
      SELECT a.category, count(*) AS total FROM assets a
      WHERE a.org_id = $1 AND ($2::uuid[] IS NULL OR a.farm_id = ANY($2::uuid[])) AND a.archived_at IS NULL
      GROUP BY 1 ORDER BY 2 DESC, 1`, scope);
    const top = categories.slice(0, CATEGORY_LIMIT).map((row) => ({ category: row.category, total: Number(row.total) }));
    const rest = categories.slice(CATEGORY_LIMIT).reduce((sum, row) => sum + Number(row.total), 0);

    return {
      periodDays: days,
      timezone: TIMEZONE,
      assetStates: [...byFarm.values()],
      occurrencesByDay: daily.map((row) => ({ day: row.day, critical: Number(row.critical), warning: Number(row.warning) })),
      availability: availability.map((row) => {
        const silent = Math.min(periodSeconds, Number(row.silent_seconds ?? 0));
        return { farmId: row.farm_id, name: row.name, silentMinutes: Math.round(silent / 60), ratio: 1 - silent / periodSeconds };
      }),
      categories: rest ? [...top, { category: 'Outras', total: rest }] : top,
      families: [...families.values()],
    };
  });
}
