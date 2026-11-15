import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { createFarm } from '../apps/web/src/server/admin';
import { createAsset } from '../apps/web/src/server/assets';
import { migrate, pgliteDatabase, type Database } from '../apps/web/src/server/db';
import { exportAssets, exportAudit } from '../apps/web/src/server/exports';
import { HttpError } from '../apps/web/src/server/http';
import type { Principal } from '../apps/web/src/server/identity';

let db: Database;
before(async () => {
  db = pgliteDatabase(await PGlite.create('memory://'));
  await migrate(db);
});
after(() => db.close());

/** Lê o diretório central do zip e devolve cada arquivo descompactado. */
function unzip(buffer: Buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50);
    const size = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const offset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    const dataStart = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    files.set(name, inflateRawSync(buffer.subarray(dataStart, dataStart + size)));
    pointer += 46 + nameLength;
  }
  return files;
}

test('planilha XLSX sai no escopo da fazenda, sem fórmulas e com identificação e marca d\'água', async () => {
  const orgId = randomUUID();
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, 'Grupo Teste & Cia']);
  const adminOid = randomUUID();
  const techOid = randomUUID();
  await db.query(`INSERT INTO memberships (org_id, entra_oid, role, display_name) VALUES ($1, $2, 'admin', 'Ana Admin'), ($1, $3, 'ti', 'Téo Técnico')`, [orgId, adminOid, techOid]);
  const admin: Principal = { orgId, actor: adminOid, role: 'admin', farmIds: null, demo: false };
  const farmA = (await createFarm(db, admin, { name: 'Fazenda Alfa', location: 'Sorriso · MT' })).id;
  const farmB = (await createFarm(db, admin, { name: 'Fazenda Beta', location: 'Sinop · MT' })).id;
  await createAsset(db, admin, { farmId: farmA, name: '=cmd|calc', category: 'Teste <b>', critical: true, ip: '10.0.0.9' });
  await createAsset(db, admin, { farmId: farmA, name: 'Balança 🌾', category: 'Balança', critical: false });
  await createAsset(db, admin, { farmId: farmB, name: 'Só da Beta', category: 'Switch', critical: false });

  const tech: Principal = { orgId, actor: techOid, role: 'ti', farmIds: [farmA], demo: false };
  const file = await exportAssets(db, tech, new URLSearchParams({ format: 'xlsx' }));
  assert.equal(file.filename, 'malha-inventario.xlsx');
  assert.equal(file.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(Buffer.isBuffer(file.body));
  const files = unzip(file.body as Buffer);
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/media/marca-dagua.png', 'docProps/core.xml']) assert.ok(files.has(part), part);
  const sheet = files.get('xl/worksheets/sheet1.xml')!.toString('utf8');

  // Escopo: a TI restrita à Alfa não leva ativos da Beta.
  assert.match(sheet, /Balança 🌾/);
  assert.doesNotMatch(sheet, /Só da Beta/);
  // Texto que parece fórmula fica como texto: nenhuma célula tem <f>.
  assert.doesNotMatch(sheet, /<f[ >]/);
  assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=cmd\|calc<\/t>/);
  assert.match(sheet, /Teste &lt;b&gt;/);
  // Identificação, cabeçalho e rodapé de impressão, e a imagem de fundo.
  assert.match(sheet, /Grupo: Grupo Teste &amp; Cia · Escopo: 1 fazenda\(s\) atribuída\(s\)/);
  assert.match(sheet, /Exportado por Téo Técnico em/);
  assert.match(sheet, /<oddHeader>.*Grupo Teste &amp;&amp; Cia/);
  assert.match(sheet, /<oddFooter>&amp;LExportado por Téo Técnico/);
  assert.match(sheet, /<picture r:id="rId1"\/>/);
  assert.match(sheet, /<autoFilter ref="A6:Q8"\/>/);
  assert.match(files.get('docProps/core.xml')!.toString('utf8'), /<dc:creator>Téo Técnico<\/dc:creator>/);
  assert.equal(files.get('xl/media/marca-dagua.png')!.subarray(1, 4).toString('latin1'), 'PNG');

  // Com uma fazenda escolhida, o escopo vem pelo nome; fazenda fora do escopo continua inexistente.
  const one = unzip((await exportAssets(db, admin, new URLSearchParams({ format: 'xlsx', farmId: farmB }))).body as Buffer);
  assert.match(one.get('xl/worksheets/sheet1.xml')!.toString('utf8'), /Escopo: Fazenda Beta/);
  await assert.rejects(exportAssets(db, tech, new URLSearchParams({ format: 'xlsx', farmId: farmB })), (error: unknown) => error instanceof HttpError && error.status === 404);
  await assert.rejects(exportAssets(db, admin, new URLSearchParams({ format: 'pdf' })), (error: unknown) => error instanceof HttpError && error.status === 400);

  // A auditoria registra o formato, e o CSV continua igual.
  const auditFile = unzip((await exportAudit(db, { ...admin, role: 'auditor' }, new URLSearchParams({ days: '30', format: 'xlsx' }))).body as Buffer);
  assert.match(auditFile.get('xl/worksheets/sheet1.xml')!.toString('utf8'), /&quot;format&quot;:&quot;xlsx&quot;/);
  const csv = await exportAssets(db, admin, new URLSearchParams());
  assert.equal(csv.contentType, 'text/csv; charset=utf-8');
  assert.match(String(csv.body), /'=cmd\|calc/);
});
