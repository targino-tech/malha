import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

test('a versão de cada migração é o número do arquivo, única e crescente, e todo arquivo está na lista', () => {
  const source = readFileSync(resolve('apps/web/src/server/db.ts'), 'utf8');
  const listed = [...source.matchAll(/\[(\d+), readFileSync\([^)]*'packages\/db\/((\d{3})_[^']+\.sql)'\)/g)].map(
    ([, version, file, prefix]) => ({ version: Number(version), file, prefix: Number(prefix) }),
  );
  assert.ok(listed.length > 0, 'a lista de migrações não foi encontrada em db.ts');
  for (const { version, file, prefix } of listed) assert.equal(version, prefix, `${file} grava a versão ${version}`);
  for (let i = 1; i < listed.length; i++) assert.ok(listed[i].version > listed[i - 1].version, `${listed[i].file} está fora de ordem`);
  const files = readdirSync(resolve('packages/db')).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
  assert.deepEqual(listed.map(({ file }) => file), files);
});
