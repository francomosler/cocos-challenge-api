import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  cashOf,
  createAccount,
  type ErrorJson,
  get,
  placeOrder,
  SEED,
  tradesOf,
} from '../helpers/actions.ts';
import { createTestContext, type TestContext } from '../helpers/test-context.ts';

const { POLL } = SEED;
const buyOne = { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', size: 1 };

describe('API: formato de errores, trazabilidad y operación', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext();
  });
  after(() => ctx?.close());

  it('GET /health/live responde sin tocar la base', async () => {
    const { status, body } = await get<{ status: string }>(ctx.app, '/health/live');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok' });
  });

  it('GET /health/ready confirma que llega a la base', async () => {
    const { status, body } = await get<{ status: string }>(ctx.app, '/health/ready');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok' });
  });

  it('una ruta inexistente responde 404 con el formato de error de la API', async () => {
    const { status, body } = await get<ErrorJson>(ctx.app, '/no-existe');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'ROUTE_NOT_FOUND');
    assert.ok(body.error.requestId);
  });

  it('devuelve el x-request-id que recibe, y también lo pone en el error', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/users/999999/portfolio',
      headers: { 'x-request-id': 'bff-trace-123' },
    });
    assert.equal(response.headers['x-request-id'], 'bff-trace-123');
    assert.equal(response.json().error.requestId, 'bff-trace-123');
  });

  it('si no recibe x-request-id, genera uno', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health/live' });
    assert.match(String(response.headers['x-request-id']), /^[0-9a-f-]{36}$/);
  });

  it('publica la especificación OpenAPI con todas las rutas', async () => {
    const { status, body } = await get<{ paths: Record<string, unknown> }>(ctx.app, '/docs/json');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.paths).sort(), [
      '/health/live',
      '/health/ready',
      '/instruments',
      '/users/{userId}/orders',
      '/users/{userId}/orders/{orderId}/cancel',
      '/users/{userId}/portfolio',
    ]);
  });
});

/**
 * Qué pasa cuando la base no da abasto. La regla: si la API no pudo confirmar la
 * operación, responde 503 sin haber escrito nada, y reintentar con la misma
 * Idempotency-Key es seguro.
 */
describe('contención y saturación de la base', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext({
      DB_POOL_MAX: '2',
      DB_CONNECT_TIMEOUT_MS: '300',
      DB_LOCK_TIMEOUT_MS: '300',
    });
  });
  after(() => ctx?.close({ verifyBalances: true }));

  it('si la fila de saldo está bloqueada demasiado tiempo → 503, sin orden; el reintento funciona', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const key = randomUUID();

    // Otra transacción retiene el saldo de la cuenta (por ejemplo, una operación colgada).
    const blocker = await ctx.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT 1 FROM balances WHERE userid = $1 AND instrumentid = $2 FOR UPDATE',
      [userId, SEED.ARS],
    );

    let blocked: Awaited<ReturnType<typeof placeOrder<ErrorJson>>>;
    try {
      blocked = await placeOrder<ErrorJson>(ctx.app, userId, buyOne, key);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }

    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error.code, 'DATABASE_BUSY');
    assert.equal(blocked.headers['retry-after'], '1');
    assert.equal((await tradesOf(ctx.pool, userId)).length, 0);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 1_000, reserved: 0 });

    const retried = await placeOrder(ctx.app, userId, buyOne, key);
    assert.equal(retried.status, 201);
    assert.equal(retried.body.status, 'FILLED');
    assert.equal((await tradesOf(ctx.pool, userId)).length, 1);
  });

  it('si no hay conexiones libres → 503 con Retry-After, sin escribir nada', async () => {
    const userId = await createAccount(ctx.pool, 1_000);

    // Se ocupan las 2 conexiones del pool: los pedidos nuevos no consiguen ninguna.
    const busy = await Promise.all([ctx.pool.connect(), ctx.pool.connect()]);
    let order: Awaited<ReturnType<typeof placeOrder<ErrorJson>>>;
    let ready: Awaited<ReturnType<typeof get<{ status: string }>>>;
    try {
      [order, ready] = await Promise.all([
        placeOrder<ErrorJson>(ctx.app, userId, buyOne),
        get<{ status: string }>(ctx.app, '/health/ready'),
      ]);
    } finally {
      for (const client of busy) client.release();
    }

    assert.equal(order.status, 503);
    assert.equal(order.body.error.code, 'DATABASE_UNAVAILABLE');
    assert.equal(order.headers['retry-after'], '2');
    assert.equal(ready.status, 503);
    assert.deepEqual(ready.body, { status: 'unavailable' });

    assert.equal((await tradesOf(ctx.pool, userId)).length, 0);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 1_000, reserved: 0 });
  });

  it('una ráfaga mayor al pool se atiende igual: los pedidos esperan una conexión', async () => {
    // 40 pedidos de 10 cuentas contra un pool de 2 conexiones. Cada cuenta tiene para 2 de sus 4.
    const users = await Promise.all(Array.from({ length: 10 }, () => createAccount(ctx.pool, 120)));

    const responses = await Promise.all(
      users.flatMap((userId) =>
        Array.from({ length: 4 }, () => placeOrder(ctx.app, userId, buyOne)),
      ),
    );

    assert.equal(responses.filter((r) => r.status === 201).length, 40);
    assert.equal(responses.filter((r) => r.body.status === 'FILLED').length, 20);
    for (const userId of users) {
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 0, reserved: 0 });
    }
  });
});
