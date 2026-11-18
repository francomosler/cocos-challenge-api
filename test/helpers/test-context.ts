import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { type App, buildApp } from '../../src/app.ts';
import { type Config, loadConfig } from '../../src/config.ts';
import { findBalanceMismatches } from '../../src/modules/orders/balance-reconciliation.repository.ts';
import { Admission } from '../../src/shared/admission.ts';
import { createPool } from '../../src/shared/db.ts';
import { runMigrations } from '../../src/shared/migrator.ts';

const ROOT = join(import.meta.dirname, '..', '..');

/** Un schema de test con más de este tiempo quedó de una corrida interrumpida. */
const STALE_SCHEMA_SECONDS = 15 * 60;

/** Una línea de log de la API, ya parseada. */
export type LogLine = Record<string, unknown> & { level: number; msg?: string; event?: string };

export interface CloseOptions {
  /** Antes de cerrar, comprueba que `balances` coincida con el recálculo desde `orders`. */
  verifyBalances?: boolean;
}

export interface TestContext {
  app: App;
  pool: pg.Pool;
  config: Config;
  /** Control de admisión de `app`: permite ver cuántos pedidos tiene en curso. */
  admission: Admission;
  /** Líneas de log emitidas por la API (solo si se pidió `captureLogs`). */
  logs: LogLine[];
  /** Otra instancia de la API sobre la misma base, como si fuera otro pod (con su propia cola). */
  startAnotherInstance(): Promise<App>;
  /**
   * Cierra la app, las conexiones y borra el schema. Siempre libera todo, también si la
   * verificación falla: de otro modo el proceso de test quedaría colgado en vez de fallar.
   */
  close(options?: CloseOptions): Promise<void>;
}

/** El nombre lleva el momento de creación para poder reconocer los schemas abandonados. */
function newSchemaName(): string {
  const createdAt = Math.floor(Date.now() / 1000).toString(36);
  return `test_${createdAt}_${randomBytes(6).toString('hex')}`;
}

function isStale(schema: string, nowSeconds: number): boolean {
  const createdAt = Number.parseInt(schema.split('_')[1] ?? '', 36);
  return Number.isNaN(createdAt) || nowSeconds - createdAt > STALE_SCHEMA_SECONDS;
}

/** Borra schemas de corridas anteriores que se cortaron antes de limpiar (Ctrl-C, un crash). */
async function dropStaleSchemas(admin: pg.Client): Promise<void> {
  const { rows } = await admin.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'test\\_%'",
  );
  const now = Math.floor(Date.now() / 1000);
  for (const { nspname } of rows.filter((row) => isStale(row.nspname, now))) {
    // Otro proceso de test puede estar borrando el mismo schema: si falla, ya no importa.
    await admin.query(`DROP SCHEMA IF EXISTS ${nspname} CASCADE`).catch(() => {});
  }
}

async function connectAdmin(databaseUrl: string): Promise<pg.Client> {
  const admin = new pg.Client({ connectionString: databaseUrl });
  try {
    await admin.connect();
    return admin;
  } catch (error) {
    throw new Error(
      `No se pudo conectar a Postgres (${(error as Error).message}). ¿Corriste "docker compose up -d db"?`,
    );
  }
}

/**
 * Cada archivo de test trabaja en un schema propio y descartable de Postgres:
 * se carga el `database.sql` oficial del challenge y encima las migraciones, igual que
 * en una instalación real. Los archivos corren en paralelo sin pisarse.
 */
export async function createTestContext(
  env: Record<string, string> = {},
  options: { captureLogs?: boolean } = {},
): Promise<TestContext> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Falta DATABASE_URL. Copiá .env.example a .env y levantá la base.');
  }

  const admin = await connectAdmin(databaseUrl);
  await dropStaleSchemas(admin);
  const schema = newSchemaName();
  await admin.query(`CREATE SCHEMA ${schema}`);

  const logLevel = options.captureLogs ? 'info' : 'silent';
  const config = loadConfig({ ...process.env, LOG_LEVEL: logLevel, ...env, DB_SCHEMA: schema });
  const pool = createPool(config.db);
  const apps: App[] = [];
  const logs: LogLine[] = [];
  const logStream = { write: (line: string) => void logs.push(JSON.parse(line) as LogLine) };

  const admission = new Admission(config.admission);
  const startInstance = async (ownAdmission?: Admission): Promise<App> => {
    const app = await buildApp({ config, pool, logStream, admission: ownAdmission });
    apps.push(app);
    return app;
  };
  const startAnotherInstance = (): Promise<App> => startInstance();

  const release = async (): Promise<void> => {
    await Promise.allSettled(apps.map((instance) => instance.close()));
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  };

  try {
    await pool.query(await readFile(join(ROOT, 'db', 'init', 'database.sql'), 'utf8'));
    await runMigrations(pool, join(ROOT, 'db', 'migrations'));
    const app = await startInstance(admission);

    return {
      app,
      pool,
      config,
      admission,
      logs,
      startAnotherInstance,
      async close({ verifyBalances = false }: CloseOptions = {}) {
        try {
          if (verifyBalances) assert.deepEqual(await findBalanceMismatches(pool), []);
        } finally {
          await release();
        }
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}
