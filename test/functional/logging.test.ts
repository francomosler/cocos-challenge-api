import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { cashOf, createAccount, SEED } from '../helpers/actions.ts';
import { createTestContext, type LogLine, type TestContext } from '../helpers/test-context.ts';

/**
 * Qué deja la API en el log. Se captura la salida real del logger (JSON por línea) y se
 * verifica por pedido, usando el x-request-id como hilo.
 */
const INFO = 30;
const WARN = 40;
const ERROR = 50;

const { POLL } = SEED;
const buyOne = { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', size: 1 };
const limitBuy = { instrumentId: POLL.id, side: 'BUY', type: 'LIMIT', size: 2, price: 50 };

describe('logging', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext(
      { DB_POOL_MAX: '2', DB_CONNECT_TIMEOUT_MS: '300', DB_LOCK_TIMEOUT_MS: '300' },
      { captureLogs: true },
    );
  });
  after(() => ctx?.close({ verifyBalances: true }));

  interface Sent {
    status: number;
    body: Record<string, unknown> & { error?: { code: string; requestId: string } };
    requestId: string;
    logs: LogLine[];
  }

  /** Envía un pedido con un x-request-id propio y devuelve solo las líneas de ese pedido. */
  async function send(
    method: 'GET' | 'POST',
    url: string,
    options: {
      body?: unknown;
      rawBody?: string;
      key?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Sent> {
    const requestId = `trace-${randomUUID()}`;
    const payload = options.rawBody ?? options.body;
    const response = await ctx.app.inject({
      method,
      url,
      headers: {
        'x-request-id': requestId,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.key ? { 'idempotency-key': options.key } : {}),
        ...options.headers,
      },
      ...(payload !== undefined ? { payload: payload as string | object } : {}),
    });
    return {
      status: response.statusCode,
      body: response.json(),
      requestId,
      logs: ctx.logs.filter((line) => line.reqId === requestId),
    };
  }

  const order = (userId: number, body: unknown, key: string = randomUUID()) =>
    send('POST', `/users/${userId}/orders`, { body, key });

  const eventsOf = (sent: Sent) => sent.logs.map((line) => line.event).filter(Boolean);
  const eventLine = (sent: Sent, event: string) =>
    sent.logs.find((line) => line.event === event) as LogLine;

  it('cada pedido deja su entrada y su salida, unidas por el requestId', async () => {
    const sent = await send('GET', '/health/live');

    assert.equal(sent.logs.length, 2);
    const [incoming, completed] = sent.logs as [LogLine, LogLine];
    const request = incoming.req as { method: string; url: string };
    assert.equal(incoming.msg, 'incoming request');
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/health/live');
    assert.equal(completed.msg, 'request completed');
    assert.equal((completed.res as { statusCode: number }).statusCode, 200);
    assert.equal(typeof completed.responseTime, 'number');
  });

  it('una orden aceptada deja order.placed con el id de la orden y sus datos', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const sent = await order(userId, buyOne);

    assert.deepEqual(eventsOf(sent), ['order.placed']);
    const line = eventLine(sent, 'order.placed');
    assert.equal(line.level, INFO);
    assert.equal(line.orderId, sent.body.id);
    assert.equal(line.userId, userId);
    assert.equal(line.instrumentId, POLL.id);
    assert.equal(line.side, 'BUY');
    assert.equal(line.type, 'MARKET');
    assert.equal(line.status, 'FILLED');
    assert.equal(line.size, 1);
    assert.equal(line.price, '60.00');
  });

  it('una orden rechazada por saldo deja order.rejected como advertencia, con el motivo', async () => {
    const userId = await createAccount(ctx.pool);
    const sent = await order(userId, buyOne);

    assert.equal(sent.status, 201);
    const line = eventLine(sent, 'order.rejected');
    assert.equal(line.level, WARN);
    assert.equal(line.reason, 'INSUFFICIENT_FUNDS');
    assert.equal(line.orderId, sent.body.id);
  });

  it('un reintento deja order.replayed, no un segundo order.placed', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const key = randomUUID();
    const first = await order(userId, buyOne, key);
    const second = await order(userId, buyOne, key);

    assert.deepEqual(eventsOf(first), ['order.placed']);
    assert.deepEqual(eventsOf(second), ['order.replayed']);
    assert.equal(eventLine(second, 'order.replayed').orderId, first.body.id);
  });

  it('cancelar deja order.cancelled; repetirlo deja order.cancel_repeated', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const placed = await order(userId, limitBuy);
    const cancelUrl = `/users/${userId}/orders/${placed.body.id}/cancel`;

    const first = await send('POST', cancelUrl);
    const second = await send('POST', cancelUrl);

    assert.deepEqual(eventsOf(first), ['order.cancelled']);
    assert.equal(eventLine(first, 'order.cancelled').orderId, placed.body.id);
    assert.deepEqual(eventsOf(second), ['order.cancel_repeated']);
  });

  it('un pedido que una regla de negocio rechaza deja request.refused con el código y el status', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const filled = await order(userId, buyOne);

    const sent = await send('POST', `/users/${userId}/orders/${filled.body.id}/cancel`);

    assert.equal(sent.status, 409);
    const line = eventLine(sent, 'request.refused');
    assert.equal(line.level, INFO);
    assert.equal(line.code, 'ORDER_NOT_CANCELLABLE');
    assert.equal(line.status, 409);
  });

  it('un pedido que no cumple el esquema deja request.invalid e indica dónde está el problema', async () => {
    const sent = await order(1, { ...buyOne, size: 'diez' });

    assert.equal(sent.status, 400);
    const line = eventLine(sent, 'request.invalid');
    assert.equal(line.level, INFO);
    assert.equal(line.in, 'body');
  });

  it('un JSON mal formado deja request.invalid con el código del framework', async () => {
    const sent = await send('POST', '/users/1/orders', {
      rawBody: '{"instrumentId": ',
      key: randomUUID(),
    });

    assert.equal(sent.status, 400);
    assert.equal(eventLine(sent, 'request.invalid').code, 'FST_ERR_CTP_INVALID_JSON_BODY');
  });

  it('un 503 por lock retenido deja request.unavailable con el motivo técnico', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const blocker = await ctx.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT 1 FROM balances WHERE userid = $1 AND instrumentid = $2 FOR UPDATE',
      [userId, SEED.ARS],
    );

    let sent: Sent;
    try {
      sent = await order(userId, buyOne);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }

    assert.equal(sent.status, 503);
    const line = eventLine(sent, 'request.unavailable');
    assert.equal(line.level, WARN);
    assert.equal(line.code, 'DATABASE_BUSY');
    assert.equal(line.reason, 'lock_timeout');
    // El motivo técnico es para operar: al cliente no se le muestra.
    assert.equal(JSON.stringify(sent.body).includes('lock_timeout'), false);
  });

  it('un 503 por falta de conexiones deja request.unavailable con motivo pool_timeout', async () => {
    const busy = await Promise.all([ctx.pool.connect(), ctx.pool.connect()]);
    let sent: Sent;
    try {
      sent = await send('GET', '/users/1/portfolio');
    } finally {
      for (const client of busy) client.release();
    }

    assert.equal(sent.status, 503);
    const line = eventLine(sent, 'request.unavailable');
    assert.equal(line.code, 'DATABASE_UNAVAILABLE');
    assert.equal(line.reason, 'pool_timeout');
  });

  it('una falla inesperada deja el error completo en el log y nada de eso en la respuesta', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    await ctx.pool.query('ALTER TABLE marketdata RENAME TO marketdata_roto');

    let sent: Sent;
    try {
      sent = await order(userId, buyOne);
    } finally {
      await ctx.pool.query('ALTER TABLE marketdata_roto RENAME TO marketdata');
    }

    // Respuesta: genérica, con el requestId para poder buscarla en el log.
    assert.equal(sent.status, 500);
    assert.deepEqual(sent.body.error, {
      code: 'INTERNAL_ERROR',
      message: 'Error interno; si el problema persiste, informá el requestId',
      requestId: sent.requestId,
    });
    assert.doesNotMatch(JSON.stringify(sent.body), /marketdata|relation|SELECT|stack/i);

    // Log: nivel error, con el mensaje original de la base y el stack.
    const line = eventLine(sent, 'request.failed');
    const err = line.err as { message: string; stack: string; code?: string };
    assert.equal(line.level, ERROR);
    assert.match(err.message, /marketdata/);
    assert.equal(err.code, '42P01'); // undefined_table
    assert.ok(err.stack.length > 0);

    // Y no quedó nada a medias.
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 1_000, reserved: 0 });
  });

  it('después de una falla inesperada la API sigue atendiendo', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const sent = await order(userId, buyOne);
    assert.equal(sent.status, 201);
  });

  it('los headers no se escriben en el log: un token no queda expuesto', async () => {
    const secret = `secreto-${randomUUID()}`;
    await send('GET', '/users/1/portfolio', { headers: { authorization: `Bearer ${secret}` } });

    assert.equal(
      ctx.logs.some((line) => JSON.stringify(line).includes(secret)),
      false,
    );
  });

  it('todas las líneas de un pedido son JSON con nivel, hora y requestId', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const sent = await order(userId, buyOne);

    assert.equal(sent.logs.length, 3); // entrada, evento de negocio, salida
    for (const line of sent.logs) {
      assert.equal(typeof line.level, 'number');
      assert.equal(typeof line.time, 'number');
      assert.equal(line.reqId, sent.requestId);
    }
  });
});
