import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { parse } from 'csv-parse/sync';
import { database, setOrg } from './db';
import { HttpError, parseJson, requestBytes, uuidPattern } from './http';
import { requireFarm, requirePermission } from './authz';
import { principal, requireSameOrigin } from './identity';
import { normalizedMac } from './network';

export const CSV_BYTES = 5 * 1024 * 1024;
const CSV_ROWS = 10_000;
const REQUIRED_COLUMNS = ['etiqueta', 'nome', 'categoria'];
const COLUMNS = new Set([...REQUIRED_COLUMNS, 'criticidade', 'mac', 'ip']);
const TRUE = new Set(['sim', 'true', '1', 'critico', 'alta']);
const FALSE = new Set(['', 'nao', 'false', '0', 'normal', 'baixa', 'padrao']);

function canonical(value: string) {
  return value.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

type Row = { line: number; name: string; tag: string; category: string; critical: boolean; mac: string | null; ip: string | null };

export function parseInventoryCsv(text: string) {
  const errors: { line: number; message: string }[] = [];
  const rows: Row[] = [];
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  const delimiter = firstLine.includes(';') ? ';' : ',';
  let parsed: { record: string[]; info: { lines: number } }[];
  try {
    parsed = parse(text, { bom: true, delimiter, trim: true, skip_empty_lines: true, info: true,
      relax_column_count: true, max_record_size: 65_536, to: CSV_ROWS + 2 }) as unknown as typeof parsed;
  } catch (error) {
    const line = error && typeof error === 'object' && 'lines' in error && typeof error.lines === 'number' ? error.lines : 1;
    return { rows, errors: [{ line, message: 'CSV inválido. Confira delimitadores e aspas.' }], total: 0 };
  }
  const headings = parsed[0]?.record.map(canonical) ?? [];
  const total = Math.max(0, parsed.length - 1);
  if (total === 0) return { rows, errors: [{ line: 1, message: 'Inclua o cabeçalho e ao menos um ativo.' }], total };
  if (total > CSV_ROWS) return { rows, errors: [{ line: 1, message: 'O limite é de 10.000 ativos por importação.' }], total };
  const missing = REQUIRED_COLUMNS.filter((column) => !headings.includes(column));
  if (missing.length || new Set(headings).size !== headings.length || headings.some((column) => !COLUMNS.has(column))) {
    const message = missing.length ? `Colunas obrigatórias ausentes: ${missing.join(', ')}.`
      : 'Há uma coluna desconhecida ou repetida. Use o cabeçalho do modelo.';
    return { rows, errors: [{ line: 1, message }], total };
  }

  const tags = new Set<string>();
  const macs = new Set<string>();
  for (const { record, info } of parsed.slice(1)) {
    const line = info.lines;
    const at = (column: string) => (record[headings.indexOf(column)] ?? '').trim();
    const tag = at('etiqueta').toUpperCase();
    const name = at('nome');
    const category = at('categoria');
    const critical = canonical(at('criticidade'));
    const rawMac = at('mac');
    const mac = normalizedMac(rawMac);
    const ip = at('ip');
    let message: string | undefined;
    if (record.length !== headings.length) message = 'O número de valores difere do cabeçalho.';
    else if (!tag || !name || !category) message = 'Preencha etiqueta, nome e categoria.';
    else if (tag.length > 80 || name.length > 160 || category.length > 80 || /[\x00-\x1F\x7F]/.test(`${tag}${name}${category}`)) {
      message = 'Etiqueta, nome ou categoria fora do tamanho permitido ou com caracteres de controle.';
    } else if (!TRUE.has(critical) && !FALSE.has(critical)) message = 'Criticidade inválida. Use sim ou não.';
    else if (rawMac && !mac) message = 'Endereço MAC inválido.';
    else if (ip && !isIP(ip)) message = 'Endereço IP inválido.';
    else if (tags.has(tag)) message = 'Etiqueta duplicada no arquivo.';
    else if (mac && macs.has(mac)) message = 'Endereço MAC duplicado no arquivo.';
    if (message) {
      errors.push({ line, message });
      continue;
    }
    tags.add(tag);
    if (mac) macs.add(mac);
    rows.push({ line, tag, name, category, critical: TRUE.has(critical), mac, ip: ip || null });
  }
  return { rows, errors, total };
}

async function importUser(request: Request) {
  requireSameOrigin(request);
  const user = await principal();
  requirePermission(user, 'inventory.write');
  return user;
}

export async function previewImport(request: Request) {
  const user = await importUser(request);
  const type = request.headers.get('Content-Type');
  if (!type?.startsWith('multipart/form-data;')) throw new HttpError(415, 'Envie um formulário com o CSV.');
  const buffered = await requestBytes(request, CSV_BYTES + 65_536);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(buffered), { headers: { 'Content-Type': type } }).formData();
  } catch {
    throw new HttpError(400, 'Formulário inválido.');
  }
  const farmId = form.get('farmId');
  const file = form.get('file');
  if (typeof farmId !== 'string' || !uuidPattern.test(farmId)) throw new HttpError(400, 'Selecione uma fazenda.');
  requireFarm(user, farmId);
  if (!file || typeof file === 'string' || !file.name.toLowerCase().endsWith('.csv')) throw new HttpError(400, 'Selecione um arquivo .csv.');
  if (file.size > CSV_BYTES) throw new HttpError(413, 'O arquivo excede 5 MiB.');
  let contents: string;
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new HttpError(400, 'Salve o arquivo como CSV UTF-8.');
  }

  const result = parseInventoryCsv(contents);
  const db = await database();
  const importId = await db.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const farm = await tx.query('SELECT 1 FROM farms WHERE org_id = $1 AND id = $2', [user.orgId, farmId]);
    if (!farm.rows.length) throw new HttpError(404, 'Fazenda indisponível.');
    if (result.errors.length) return null;
    const id = randomUUID();
    await tx.query('INSERT INTO imports (org_id, farm_id, id, actor, rows, expires_at) VALUES ($1, $2, $3, $4, $5::jsonb, now() + interval \'30 minutes\')',
      [user.orgId, farmId, id, user.actor, JSON.stringify(result.rows)]);
    return id;
  });
  return { importId, rows: result.rows.slice(0, 50), errors: result.errors.slice(0, 100), total: result.total };
}

export async function commitImport(request: Request) {
  const user = await importUser(request);
  const body = parseJson(await requestBytes(request, 1024));
  const importId = body && typeof body === 'object' && 'importId' in body && body.importId;
  if (typeof importId !== 'string' || !uuidPattern.test(importId)) throw new HttpError(400, 'Importação inválida.');
  const db = await database();
  return db.transaction(async (tx) => {
    await setOrg(tx, user.orgId);
    const { rows: [record] } = await tx.query<{ farm_id: string; rows: Row[]; imported_count: number | null; expired: boolean }>(
      `SELECT farm_id, rows, imported_count, expires_at <= now() AS expired FROM imports
       WHERE org_id = $1 AND id = $2 AND actor = $3 FOR UPDATE`, [user.orgId, importId, user.actor]);
    if (!record) throw new HttpError(404, 'Importação indisponível.');
    requireFarm(user, record.farm_id);
    if (record.imported_count !== null) return { imported: record.imported_count };
    if (record.expired) throw new HttpError(410, 'A prévia expirou. Importe o arquivo novamente.');
    await tx.query('SELECT 1 FROM farms WHERE org_id = $1 AND id = $2 FOR UPDATE', [user.orgId, record.farm_id]);
    const data = JSON.stringify(record.rows.map((row) => ({ ...row, id: randomUUID() })));
    const args = [user.orgId, record.farm_id, data];
    const { rows: [conflict] } = await tx.query<{ tag: string }>(`
      SELECT incoming.tag FROM jsonb_to_recordset($3::jsonb) AS incoming(tag text, mac text)
      JOIN assets a ON a.org_id = $1 AND a.farm_id = $2 AND a.mac = incoming.mac
      WHERE a.tag IS NOT NULL AND a.tag <> incoming.tag LIMIT 1`, args);
    if (conflict) throw new HttpError(409, `A etiqueta ${conflict.tag} usa um MAC já vinculado a outra etiqueta.`);
    await tx.query(`WITH incoming AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(id uuid, tag text, name text, category text, critical boolean, mac text, ip text)
    ), adopted AS (
      UPDATE assets a SET tag = i.tag, name = i.name, category = i.category, critical = i.critical, source = 'csv'
      FROM incoming i WHERE a.org_id = $1 AND a.farm_id = $2 AND a.tag IS NULL AND a.mac = i.mac
        AND 1 = (SELECT count(*) FROM assets b WHERE b.org_id = $1 AND b.farm_id = $2 AND b.mac = i.mac)
        AND NOT EXISTS (SELECT 1 FROM assets b WHERE b.org_id = $1 AND b.farm_id = $2 AND b.tag = i.tag)
      RETURNING a.tag
    ) INSERT INTO assets (org_id, farm_id, id, tag, name, category, critical, mac, ip, source)
      SELECT $1, $2, id, tag, name, category, critical, mac, ip, 'csv' FROM incoming
      WHERE NOT EXISTS (SELECT 1 FROM adopted WHERE adopted.tag = incoming.tag)
      ON CONFLICT (org_id, farm_id, tag) DO UPDATE SET name = excluded.name, category = excluded.category,
        critical = excluded.critical, source = 'csv', mac = CASE WHEN assets.external_id IS NULL THEN excluded.mac ELSE assets.mac END,
        ip = CASE WHEN assets.external_id IS NULL THEN excluded.ip ELSE assets.ip END`, args);
    await tx.query('UPDATE imports SET imported_count = $3, rows = \'[]\'::jsonb WHERE org_id = $1 AND id = $2', [user.orgId, importId, record.rows.length]);
    await tx.query('INSERT INTO audit_log (id, org_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [randomUUID(), user.orgId, user.actor, 'inventory.import', JSON.stringify({ farmId: record.farm_id, importId, count: record.rows.length })]);
    return { imported: record.rows.length };
  });
}
