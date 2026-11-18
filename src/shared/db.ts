import pg from 'pg';
import type { DatabaseConfig } from '../config.ts';
import { ServiceUnavailableError } from './errors.ts';
import type { UnitOfWork } from './unit-of-work.ts';

export type Row = pg.QueryResultRow;

/** Lo mínimo que necesita un repositorio: sirve tanto el pool como una transacción. */
export interface Queryable {
  query<R extends Row = Row>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export type TransactionMode =
  /** READ COMMITTED: cada sentencia ve lo último confirmado. Es lo que usan las escrituras. */
  | 'read-write'
  /** REPEATABLE READ de solo lectura: todas las consultas ven la misma foto. */
  | 'snapshot';

const BEGIN: Record<TransactionMode, string> = {
  'read-write': 'BEGIN',
  snapshot: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
};

const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;

/**
 * `orders.datetime` es TIMESTAMP sin zona y se guarda en UTC. El driver, por defecto,
 * lo interpretaría en la zona horaria del proceso; acá se fija UTC. Las fechas (`DATE`)
 * se dejan como texto `YYYY-MM-DD` para no inventarles una hora.
 */
const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === OID_TIMESTAMP) return (value: string) => new Date(`${value.replace(' ', 'T')}Z`);
    if (oid === OID_DATE) return (value: string) => value;
    return pg.types.getTypeParser(oid, format as 'text');
  }) as pg.CustomTypesConfig['getTypeParser'],
};

export function createPool(config: DatabaseConfig): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectTimeoutMs,
    // Ninguna transacción espera un lock ni corre una sentencia sin límite de tiempo.
    lock_timeout: config.lockTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.statementTimeoutMs * 2,
    types: typeParsers,
    ...(config.schema ? { options: `-c search_path=${config.schema}` } : {}),
  });
  // Un error en una conexión ociosa no debe tirar el proceso: el pool la descarta.
  pool.on('error', () => {});
  return pool;
}

/** Códigos SQLSTATE que indican contención o sobrecarga pasajera, y cómo se los nombra en el log. */
const TRANSIENT_SQLSTATES: Record<string, string> = {
  '55P03': 'lock_timeout',
  '57014': 'statement_timeout',
  '40P01': 'deadlock_detected',
  '40001': 'serialization_failure',
  '53300': 'too_many_connections',
};

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

export function sqlState(error: unknown): string | undefined {
  return error instanceof pg.DatabaseError ? error.code : undefined;
}

/** Motivo técnico de una falla transitoria de la base, o `undefined` si no lo es. */
function transientReason(error: unknown): string | undefined {
  const state = sqlState(error);
  if (state !== undefined && state in TRANSIENT_SQLSTATES) return TRANSIENT_SQLSTATES[state];
  if (!(error instanceof Error)) return undefined;
  if (error.message.includes('timeout exceeded when trying to connect')) return 'pool_timeout';
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && CONNECTION_ERROR_CODES.has(code) ? 'connection_error' : undefined;
}

/**
 * Traduce fallas transitorias de la base a un error de aplicación reintentable.
 * En todos estos casos la transacción no confirmó nada, así que reintentar es seguro.
 * El motivo técnico viaja en el error para que quede en el log.
 */
export function translateDatabaseError(error: unknown): unknown {
  const reason = transientReason(error);
  if (reason === undefined) return error;

  const noConnection = reason === 'pool_timeout' || reason === 'connection_error';
  return noConnection
    ? new ServiceUnavailableError(
        'DATABASE_UNAVAILABLE',
        'No hay conexión disponible con la base de datos; reintentá en unos instantes',
        { retryAfterSeconds: 2, reason, cause: error },
      )
    : new ServiceUnavailableError(
        'DATABASE_BUSY',
        'La base de datos está ocupada; reintentá en unos instantes',
        { reason, cause: error },
      );
}

export class Database implements Queryable {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async query<R extends Row = Row>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    try {
      return await this.pool.query<R>(text, values);
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  /**
   * Adapta una transacción al puerto `UnitOfWork`. `bind` arma, sobre la conexión de la
   * transacción, los almacenes que el caso de uso va a usar; así el caso de uso nunca ve
   * la conexión.
   */
  unitOfWork<Context>(
    bind: (tx: Queryable) => Context,
    mode: TransactionMode = 'read-write',
  ): UnitOfWork<Context> {
    return { run: (work) => this.transaction((tx) => work(bind(tx)), mode) };
  }

  /** Todo lo que haga `work` sobre `tx` se confirma junto o no se confirma. */
  async transaction<T>(
    work: (tx: Queryable) => Promise<T>,
    mode: TransactionMode = 'read-write',
  ): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw translateDatabaseError(error);
    }

    let connectionBroken = false;
    try {
      await client.query(BEGIN[mode]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        connectionBroken = true;
      });
      throw translateDatabaseError(error);
    } finally {
      client.release(connectionBroken);
    }
  }
}
