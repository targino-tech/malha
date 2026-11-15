import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createHash } from 'node:crypto';

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  transaction<T>(operation: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const DEMO_ORG = '00000000-0000-4000-8000-000000000001';
export const DEMO_FARM = '00000000-0000-4000-8000-000000000101';
export const DEMO_ENROLLMENT = 'malha-demo-entrada-000000000000000000000000';

export function mode() {
  const value = process.env.MALHA_MODE;
  if (value !== 'demo' && value !== 'pilot') throw new Error('Defina MALHA_MODE como demo ou pilot.');
  return value;
}

export function hash(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

function postgresConnection(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString, max: 10 });
  function adapt(client: pg.Pool | pg.PoolClient): Queryable {
    return {
      query: (sql, params) => client.query(sql, params),
      exec: async (sql) => { await client.query(sql); },
    };
  }
  return {
    ...adapt(pool),
    async transaction(operation) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await operation(adapt(client));
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function pgliteDatabase(client: PGlite): Database {
  return {
    query: (sql, params) => client.query(sql, params),
    exec: async (sql) => { await client.exec(sql); },
    transaction: (operation) => client.transaction(async (tx) => operation({
      query: (sql, params) => tx.query(sql, params),
      exec: async (sql) => { await tx.exec(sql); },
    })),
    close: () => client.close(),
  };
}

async function demoConnection(): Promise<Database> {
  const directory = process.env.MALHA_DEMO_DB ?? resolve(process.cwd(), '.malha/demo');
  if (directory !== 'memory://') mkdirSync(dirname(resolve(/* turbopackIgnore: true */ directory)), { recursive: true });
  const { PGlite: Engine } = await import('@electric-sql/pglite');
  const db = pgliteDatabase(await Engine.create(directory));
  await migrate(db);
  await seedDemo(db);
  return db;
}

export function connectPostgres(connectionString?: string) {
  if (!connectionString) throw new Error('DATABASE_URL é obrigatória para PostgreSQL.');
  return postgresConnection(connectionString);
}

const scope = globalThis as typeof globalThis & { malhaDatabase?: Promise<Database> };

export function database() {
  if (!scope.malhaDatabase) {
    scope.malhaDatabase = mode() === 'demo'
      ? demoConnection()
      : Promise.resolve(connectPostgres(process.env.DATABASE_URL));
    void scope.malhaDatabase.catch(() => { delete scope.malhaDatabase; });
  }
  return scope.malhaDatabase;
}

export async function setOrg(tx: Queryable, orgId: string) {
  await tx.query('SELECT set_config($1, $2, true)', ['malha.org_id', orgId]);
}

export async function migrate(db: Database) {
  // A versão gravada em malha_migrations é o número do arquivo, não a posição na lista.
  // Assim, números reservados por outras frentes podem ficar livres sem deslocar as demais.
  const migrations: Array<readonly [number, string]> = [
    [1, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/001_inventory.sql'), 'utf8')],
    [2, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/002_collector_limits.sql'), 'utf8')],
    [3, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/003_occurrences.sql'), 'utf8')],
    [4, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/004_access_inventory.sql'), 'utf8')],
    [5, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/005_history_value.sql'), 'utf8')],
    [6, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/006_clock_skew.sql'), 'utf8')],
    [7, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/007_site_requests.sql'), 'utf8')],
    [8, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/008_farm_coordinates.sql'), 'utf8')],
    [9, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/009_ldap.sql'), 'utf8')],
    [10, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/010_monitoring_connections.sql'), 'utf8')],
    [11, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/011_oidc_identities.sql'), 'utf8')],
    [14, readFileSync(/* turbopackIgnore: true */ resolve('packages/db/014_alertas_push.sql'), 'utf8')],
  ];
  await db.transaction(async (tx) => {
    await tx.exec('SELECT pg_advisory_xact_lock(58147261)');
    await tx.exec('CREATE TABLE IF NOT EXISTS malha_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await tx.query<{ version: number }>('SELECT version FROM malha_migrations');
    const completed = new Set(rows.map(({ version }) => version));
    for (const [version, sql] of migrations) {
      if (completed.has(version)) continue;
      await tx.exec(sql);
      await tx.query('INSERT INTO malha_migrations(version) VALUES ($1)', [version]);
    }
  });
}

async function seedDemo(db: Database) {
  await db.transaction(async (tx) => {
    const created = await tx.query('INSERT INTO organizations VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id', [DEMO_ORG, 'Grupo Horizonte']);
    if (!created.rows.length) return;
    await setOrg(tx, DEMO_ORG);
    await tx.exec(readFileSync(/* turbopackIgnore: true */ resolve('packages/db/demo.sql'), 'utf8'));
    await tx.query('INSERT INTO enrollment_codes (code_hash, org_id, farm_id, expires_at) VALUES ($1, $2, $3, now() + interval \'365 days\')', [hash(DEMO_ENROLLMENT), DEMO_ORG, DEMO_FARM]);
  });
}
