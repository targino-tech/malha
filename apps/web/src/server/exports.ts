import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ASSET_FROM, ASSET_STATUS } from './assets';
import { requireFarm, requirePermission } from './authz';
import { setOrg, type Database, type Queryable } from './db';
import { HttpError, uuidPattern } from './http';
import type { Principal } from './identity';
import { buildXlsx, type Cell } from './xlsx';

/**
 * Célula segura para planilhas: neutraliza fórmulas (=, +, -, @, tab, CR) com apóstrofo e escapa aspas.
 * Usa ponto e vírgula como separador, que o Excel em português abre sem assistente.
 */
export function csvCell(value: unknown) {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";,\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(header: string[], rows: unknown[][]) {
  return `﻿${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

async function audit(tx: Queryable, user: Principal, action: string, scope: object) {
  await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [randomUUID(), user.orgId, user.actor, action, JSON.stringify(scope)]);
}

const exportSchema = z.object({
  farmId: z.string().regex(uuidPattern).optional(),
  days: z.enum(['7', '30', '90', '365']).default('30'),
  format: z.enum(['csv', 'xlsx']).default('csv'),
});
type Format = 'csv' | 'xlsx';

function exportScope(user: Principal, params: URLSearchParams) {
  const parsed = exportSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new HttpError(400, 'Filtro de exportação inválido.');
  if (parsed.data.farmId) requireFarm(user, parsed.data.farmId);
  return { farmIds: parsed.data.farmId ? [parsed.data.farmId] : user.farmIds, days: Number(parsed.data.days), farmId: parsed.data.farmId ?? null, format: parsed.data.format as Format };
}

export type ExportFile = { filename: string; body: string | Buffer; contentType: string };
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Entrega a mesma tabela em CSV (como sempre) ou em XLSX padronizado, com o grupo, o escopo,
 * quem exportou e a marca d'água do Malha.
 */
async function deliver(tx: Queryable, user: Principal, file: { name: string; title: string; header: string[]; rows: Cell[][]; farmId: string | null; format: Format }): Promise<ExportFile> {
  if (file.format === 'csv') return { filename: `${file.name}.csv`, body: toCsv(file.header, file.rows), contentType: 'text/csv; charset=utf-8' };
  const { rows: [meta] } = await tx.query<{ org: string; actor_name: string | null; farm: string | null }>(`SELECT o.name AS org, m.display_name AS actor_name, f.name AS farm
    FROM organizations o
    LEFT JOIN memberships m ON m.org_id = o.id AND m.entra_oid::text = $2
    LEFT JOIN farms f ON f.org_id = o.id AND f.id = $3::uuid
    WHERE o.id = $1`, [user.orgId, user.actor, file.farmId]);
  const scope = meta?.farm ?? (user.farmIds ? `${user.farmIds.length} fazenda(s) atribuída(s)` : 'Todas as fazendas');
  const body = buildXlsx({ title: file.title, group: meta?.org ?? 'Grupo', scope, exportedBy: meta?.actor_name ?? `Usuário ${user.actor.slice(0, 8)}`, exportedAt: new Date() }, file.header, file.rows);
  return { filename: `${file.name}.xlsx`, body, contentType: XLSX_TYPE };
}

export async function exportAssets(database: Database, user: Principal, params: URLSearchParams): Promise<ExportFile> {
  requirePermission(user, 'exports.run');
  const scope = exportScope(user, params);
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT f.name AS farm, a.tag, a.name, a.category, l.name AS location, a.owner, a.source,
        ${ASSET_STATUS} AS status, a.ip, a.mac, a.model, a.firmware, a.critical, a.last_observed_at, a.reviewed_at, a.maintenance_until, a.archived_at
      FROM ${ASSET_FROM} JOIN farms f ON f.org_id = a.org_id AND f.id = a.farm_id
      WHERE a.org_id = $1 AND ($2::uuid[] IS NULL OR a.farm_id = ANY($2::uuid[])) ORDER BY f.name, a.name, a.id`, [user.orgId, scope.farmIds]);
    await audit(tx, user, 'export.assets', { farmId: scope.farmId, rows: rows.length, format: scope.format });
    return deliver(tx, user, {
      name: 'malha-inventario', title: 'Inventário de ativos', farmId: scope.farmId, format: scope.format,
      header: ['fazenda', 'etiqueta', 'nome', 'categoria', 'local', 'responsavel', 'origem', 'estado', 'ip', 'mac', 'modelo', 'firmware',
        'critico', 'ultima_observacao', 'conferido_em', 'manutencao_ate', 'arquivado_em'],
      rows: rows.map((row) => [row.farm, row.tag, row.name, row.category, row.location, row.owner, row.source, row.status, row.ip, row.mac, row.model,
        row.firmware, row.critical ? 'sim' : 'não', row.last_observed_at, row.reviewed_at, row.maintenance_until, row.archived_at] as Cell[]),
    });
  });
}

export async function exportOccurrences(database: Database, user: Principal, params: URLSearchParams): Promise<ExportFile> {
  requirePermission(user, 'exports.run');
  const scope = exportScope(user, params);
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT f.name AS farm, o.rule, o.severity, o.title, o.first_observed_at, o.opened_at,
        o.acknowledged_at, coalesce(m.display_name, o.acknowledged_by) AS acknowledged_by, o.resolved_at
      FROM occurrences o JOIN farms f ON f.org_id = o.org_id AND f.id = o.farm_id
      LEFT JOIN memberships m ON m.org_id = o.org_id AND m.entra_oid::text = o.acknowledged_by
      WHERE o.org_id = $1 AND ($2::uuid[] IS NULL OR o.farm_id = ANY($2::uuid[])) AND o.opened_at >= now() - make_interval(days => $3)
      ORDER BY o.opened_at DESC`, [user.orgId, scope.farmIds, scope.days]);
    await audit(tx, user, 'export.occurrences', { farmId: scope.farmId, days: scope.days, rows: rows.length, format: scope.format });
    return deliver(tx, user, {
      name: 'malha-ocorrencias', title: `Ocorrências dos últimos ${scope.days} dias`, farmId: scope.farmId, format: scope.format,
      header: ['fazenda', 'regra', 'severidade', 'titulo', 'evidencia_desde', 'aberta_em', 'reconhecida_em', 'reconhecida_por', 'encerrada_em'],
      rows: rows.map((row) => [row.farm, row.rule, row.severity, row.title, row.first_observed_at, row.opened_at, row.acknowledged_at, row.acknowledged_by, row.resolved_at] as Cell[]),
    });
  });
}

export type AuditEntry = { id: string; occurredAt: string; actor: string; actorName: string | null; action: string; scope: Record<string, unknown> };

const auditSchema = z.object({ cursor: z.string().max(200).optional(), action: z.string().regex(/^[a-z_.]{1,60}$/).optional() });

/** Trilha de auditoria do grupo, mais recente primeiro, com paginação por cursor (horário, id). */
/**
 * Quem tem acesso restrito a fazendas só vê eventos dessas fazendas. Eventos do grupo inteiro
 * (membros, diretórios, integrações) ficam só para quem enxerga todas as fazendas.
 */
const AUDIT_FARM_FILTER = (param: string) => `(${param}::uuid[] IS NULL OR a.scope->>'farmId' = ANY(${param}::text[]))`;

export async function listAudit(database: Database, user: Principal, params: URLSearchParams) {
  requirePermission(user, 'audit.read');
  const parsed = auditSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new HttpError(400, 'Filtro de auditoria inválido.');
  let cursor: { at: string; id: string } | null = null;
  if (parsed.data.cursor) {
    try {
      cursor = z.object({ at: z.iso.datetime(), id: z.string().regex(uuidPattern) }).parse(JSON.parse(Buffer.from(parsed.data.cursor, 'base64url').toString('utf8')));
    } catch {
      throw new HttpError(400, 'Página inválida.');
    }
  }
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows } = await tx.query<{ id: string; occurred_at: Date; actor: string; display_name: string | null; action: string; scope: Record<string, unknown> }>(`
      SELECT a.id, a.occurred_at, a.actor, m.display_name, a.action, a.scope FROM audit_log a
      LEFT JOIN memberships m ON m.org_id = a.org_id AND m.entra_oid::text = a.actor
      WHERE a.org_id = $1 AND ($2::text IS NULL OR a.action LIKE $2 || '%')
        AND ($3::timestamptz IS NULL OR (a.occurred_at, a.id) < ($3::timestamptz, $4::uuid))
        AND ${AUDIT_FARM_FILTER('$5')}
      ORDER BY a.occurred_at DESC, a.id DESC LIMIT 51`, [user.orgId, parsed.data.action ?? null, cursor?.at ?? null, cursor?.id ?? null, user.farmIds]);
    const page = rows.slice(0, 50);
    const last = page.at(-1);
    return {
      items: page.map((row): AuditEntry => ({ id: row.id, occurredAt: new Date(row.occurred_at).toISOString(), actor: row.actor,
        actorName: row.display_name, action: row.action, scope: row.scope })),
      nextCursor: rows.length > 50 && last ? Buffer.from(JSON.stringify({ at: new Date(last.occurred_at).toISOString(), id: last.id })).toString('base64url') : null,
    };
  });
}

export async function exportAudit(database: Database, user: Principal, params: URLSearchParams): Promise<ExportFile> {
  requirePermission(user, 'audit.read');
  const { days, format } = exportScope({ ...user, farmIds: null }, new URLSearchParams({ days: params.get('days') ?? '30', format: params.get('format') ?? 'csv' }));
  return database.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT a.occurred_at, a.actor, m.display_name, a.action, a.scope
      FROM audit_log a LEFT JOIN memberships m ON m.org_id = a.org_id AND m.entra_oid::text = a.actor
      WHERE a.org_id = $1 AND a.occurred_at >= now() - make_interval(days => $2) AND ${AUDIT_FARM_FILTER('$3')}
      ORDER BY a.occurred_at DESC`, [user.orgId, days, user.farmIds]);
    await audit(tx, user, 'export.audit', { days, rows: rows.length, format });
    return deliver(tx, user, {
      name: 'malha-auditoria', title: `Auditoria dos últimos ${days} dias`, farmId: null, format,
      header: ['horario', 'ator', 'nome', 'acao', 'escopo'],
      rows: rows.map((row) => [row.occurred_at, row.actor, row.display_name, row.action, JSON.stringify(row.scope)] as Cell[]),
    });
  });
}

/** Retenção do piloto: 30 dias para lotes brutos e observações individuais, 90 dias para o histórico de entregas de alertas. A auditoria fica 365 dias. */
export async function applyRetention(database: Database) {
  const { rows: organizations } = await database.query<{ id: string }>('SELECT id FROM organizations ORDER BY id');
  for (const { id } of organizations) {
    await database.transaction(async (tx) => {
      await setOrg(tx, id);
      await tx.query(`DELETE FROM asset_observations WHERE org_id = $1 AND observed_at < now() - interval '30 days'`, [id]);
      // Dados de rede: série de tráfego por 30 dias; leituras brutas de contadores só pelo tempo do recálculo.
      await tx.query(`DELETE FROM traffic_samples WHERE org_id = $1 AND observed_at < now() - interval '30 days'`, [id]);
      await tx.query(`DELETE FROM port_counter_readings WHERE org_id = $1 AND observed_at < now() - interval '2 days'`, [id]);
      await tx.query(`DELETE FROM capture_batches b WHERE b.org_id = $1 AND b.received_at < now() - interval '30 days'
        AND EXISTS (SELECT 1 FROM captures c WHERE c.org_id = b.org_id AND c.farm_id = b.farm_id AND c.collector_id = b.collector_id
          AND c.id = b.capture_id AND c.applied_at IS NOT NULL)`, [id]);
      // Histórico de entregas de alertas: 90 dias. Pendências ficam até serem resolvidas pelo worker.
      await tx.query(`DELETE FROM notification_deliveries WHERE org_id = $1 AND status <> 'pending' AND created_at < now() - interval '90 days'`, [id]);
    });
  }
}

/** Resposta de download para CSV ou XLSX, sem cache e com o tipo declarado. */
export function downloadResponse(file: ExportFile) {
  return new Response(typeof file.body === 'string' ? file.body : new Uint8Array(file.body), { headers: {
    'Content-Type': file.contentType,
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}
