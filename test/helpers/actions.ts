import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { App } from '../../src/app.ts';
import { findBalanceMismatches } from '../../src/modules/orders/balance-reconciliation.repository.ts';

/** Datos del `database.sql` del challenge que usan los tests. */
export const SEED = {
  /** Usuario con historial (11 órdenes). Los usuarios 2, 3 y 4 no tienen ninguna. */
  userWithHistory: 1,
  emptyUsers: [2, 3, 4] as const,
  ARS: 66,
  POLL: { id: 53, close: 60 }, // precio redondo: cómodo para las cuentas
  DYCA: { id: 1, close: 259 },
  DOME: { id: 12, close: 20.5 },
  PAMP: { id: 47, close: 925.85 },
  METR: { id: 54, close: 229.5 },
  BMA: { id: 31, close: 1502.8 },
  /** Instrumentos sin ninguna fila en `marketdata`. */
  withoutPrice: [3, 10] as const,
};

export interface OrderBody {
  instrumentId: number;
  side: string;
  type: string;
  size?: unknown;
  amount?: unknown;
  price?: unknown;
  [extra: string]: unknown;
}

export interface OrderJson {
  id: number;
  userId: number;
  instrumentId: number;
  side: string;
  type: string;
  status: string;
  size: number;
  price: number;
  total: number;
  rejectionReason: string | null;
  datetime: string;
}

export interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId: string };
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
}

export async function placeOrder<T = OrderJson>(
  app: App,
  userId: number,
  body: OrderBody,
  idempotencyKey: string | null = randomUUID(),
): Promise<ApiResponse<T>> {
  const response = await app.inject({
    method: 'POST',
    url: `/users/${userId}/orders`,
    headers: idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey },
    payload: body,
  });
  return { status: response.statusCode, body: response.json() as T, headers: response.headers };
}

export async function cancelOrder<T = OrderJson>(
  app: App,
  userId: number,
  orderId: number,
): Promise<ApiResponse<T>> {
  const response = await app.inject({
    method: 'POST',
    url: `/users/${userId}/orders/${orderId}/cancel`,
  });
  return { status: response.statusCode, body: response.json() as T, headers: response.headers };
}

export async function get<T>(app: App, url: string): Promise<ApiResponse<T>> {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() as T, headers: response.headers };
}

/**
 * Acredita pesos como lo haría una transferencia entrante: una orden CASH_IN ejecutada
 * y su reflejo en `balances`, en la misma transacción.
 */
export async function fund(pool: pg.Pool, userId: number, pesos: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO orders (instrumentid, userid, size, price, type, side, status, datetime)
       VALUES ($1, $2, $3, 1, 'MARKET', 'CASH_IN', 'FILLED', now() AT TIME ZONE 'UTC')`,
      [SEED.ARS, userId, pesos],
    );
    await client.query(
      `INSERT INTO balances (userid, instrumentid, available) VALUES ($1, $2, $3)
       ON CONFLICT (userid, instrumentid)
       DO UPDATE SET available = balances.available + EXCLUDED.available`,
      [userId, SEED.ARS, pesos],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Crea una cuenta nueva y vacía (o con `pesos`), para que cada test tenga la suya. */
export async function createAccount(pool: pg.Pool, pesos = 0): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO users (email, accountnumber) VALUES ($1, $2) RETURNING id',
    [`${randomUUID()}@test.com`, randomUUID().slice(0, 8)],
  );
  const userId = rows[0]?.id as number;
  if (pesos > 0) await fund(pool, userId, pesos);
  return userId;
}

/**
 * Deja a la cuenta con `size` acciones compradas por la propia API (orden MARKET),
 * acreditando antes los pesos justos. `close` debe ser un precio en pesos enteros.
 */
export async function holdShares(
  app: App,
  pool: pg.Pool,
  userId: number,
  instrument: { id: number; close: number },
  size: number,
): Promise<void> {
  await fund(pool, userId, size * instrument.close);
  const bought = await placeOrder(app, userId, {
    instrumentId: instrument.id,
    side: 'BUY',
    type: 'MARKET',
    size,
  });
  assert.equal(bought.body.status, 'FILLED');
}

export interface Balance {
  available: number;
  reserved: number;
}

export async function balanceOf(
  pool: pg.Pool,
  userId: number,
  instrumentId: number,
): Promise<Balance> {
  const { rows } = await pool.query<{ available: string; reserved: string }>(
    'SELECT available, reserved FROM balances WHERE userid = $1 AND instrumentid = $2',
    [userId, instrumentId],
  );
  const row = rows[0];
  return { available: Number(row?.available ?? 0), reserved: Number(row?.reserved ?? 0) };
}

export const cashOf = (pool: pg.Pool, userId: number) => balanceOf(pool, userId, SEED.ARS);

export interface StoredOrder {
  id: number;
  instrumentid: number;
  side: string;
  type: string;
  status: string;
  size: number;
  price: string;
  rejection_reason: string | null;
  idempotency_key: string | null;
}

/** Órdenes del usuario tal como quedaron en la tabla, sin contar transferencias. */
export async function tradesOf(pool: pg.Pool, userId: number): Promise<StoredOrder[]> {
  const { rows } = await pool.query<StoredOrder>(
    `SELECT id, instrumentid, side, type, status, size, price, rejection_reason, idempotency_key
     FROM orders
     WHERE userid = $1 AND side IN ('BUY', 'SELL')
     ORDER BY id`,
    [userId],
  );
  return rows;
}

export async function countOrders(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM orders');
  return Number(rows[0]?.count);
}

/** Invariante central: `balances` coincide con lo que se recalcula desde `orders`. */
export async function assertBalancesMatchLedger(pool: pg.Pool): Promise<void> {
  assert.deepEqual(await findBalanceMismatches(pool), []);
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}
