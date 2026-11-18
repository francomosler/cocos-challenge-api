import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import {
  type ApiResponse,
  assertBalancesMatchLedger,
  cancelOrder,
  cashOf,
  countBy,
  createAccount,
  type ErrorJson,
  get,
  type OrderJson,
  placeOrder,
  SEED,
  tradesOf,
} from '../helpers/actions.ts';
import { createTestContext, type LogLine, type TestContext } from '../helpers/test-context.ts';

/**
 * Control de admisión: turnos por cuenta y tope global de pedidos en curso.
 *
 * Para que un pedido quede "en curso" el tiempo que el test necesita, otra sesión de base
 * retiene el saldo de la cuenta: sus órdenes entran a la transacción y esperan ahí. Así se
 * ve, sin depender de tiempos, quién trabaja, quién espera y quién es rechazado.
 */
const INFO = 30;
const WARN = 40;

const { POLL } = SEED;
const buyOne = { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', size: 1 };
const limitBuy = { instrumentId: POLL.id, side: 'BUY', type: 'LIMIT', size: 2, price: 50 };

type AnyResponse = ApiResponse<OrderJson & ErrorJson>;
const order = (ctx: TestContext, userId: number, key: string = randomUUID()) =>
  placeOrder<OrderJson & ErrorJson>(ctx.app, userId, buyOne, key);
const httpStatuses = (responses: ApiResponse<unknown>[]) =>
  countBy(responses, (response) => String(response.status));

/** Sesiones que esperan, directa o indirectamente, un lock que tiene la sesión que pregunta. */
const BLOCKED_BY_ME = `
  WITH RECURSIVE blocked AS (
    SELECT pid FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
    UNION
    SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
  )
  SELECT count(*)::int AS blocked FROM blocked`;

/**
 * Otra sesión de base, ajena a la API, que retiene el saldo en pesos de las cuentas dadas:
 * toda orden de esas cuentas queda esperando adentro de su transacción hasta `release`.
 */
async function holdCash(ctx: TestContext, userIds: number[]) {
  const session = new pg.Client({
    connectionString: ctx.config.db.url,
    options: `-c search_path=${ctx.config.db.schema}`,
  });
  await session.connect();
  await session.query('BEGIN');
  await session.query(
    'SELECT 1 FROM balances WHERE userid = ANY($1::int[]) AND instrumentid = $2 FOR UPDATE',
    [userIds, SEED.ARS],
  );
  let released = false;
  return {
    /** Cuántas conexiones de la API están esperando que se suelte el saldo. */
    async blocked(): Promise<number> {
      // Dentro de una transacción, Postgres congela lo que muestra pg_stat_activity.
      await session.query('SELECT pg_stat_clear_snapshot()');
      const { rows } = await session.query<{ blocked: number }>(BLOCKED_BY_ME);
      return rows[0]?.blocked ?? 0;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await session.query('ROLLBACK');
      await session.end();
    },
  };
}

async function until(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(`no se cumplió a tiempo: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const busyConnections = (ctx: TestContext) => ctx.pool.totalCount - ctx.pool.idleCount;

/** La línea de log que explica el rechazo de un pedido, buscada por su x-request-id. */
function refusalLog(ctx: TestContext, response: ApiResponse<unknown>): LogLine {
  const line = ctx.logs.find(
    (candidate) =>
      candidate.reqId === response.headers['x-request-id'] &&
      String(candidate.event).startsWith('request.'),
  );
  assert.ok(line, 'el rechazo no quedó en el log');
  return line;
}

describe('control de admisión con los límites por defecto (2 a la vez, 20 esperando)', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext({}, { captureLogs: true });
  });
  after(() => ctx?.close({ verifyBalances: true }));

  it('20 compras simultáneas con saldo para 7: entran las 20 y se ejecutan 7', async () => {
    const userId = await createAccount(ctx.pool, 479);

    const responses = await Promise.all(Array.from({ length: 20 }, () => order(ctx, userId)));

    assert.deepEqual(httpStatuses(responses), { '201': 20 });
    assert.deepEqual(
      countBy(responses, (r) => r.body.status),
      { FILLED: 7, REJECTED: 13 },
    );
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 59, reserved: 0 });
    assert.deepEqual(ctx.admission.snapshot(), { inFlight: 0, busyAccounts: 0 });
  });

  it('una cuenta trabada ocupa 2 conexiones y las demás cuentas siguen operando', async () => {
    const stuck = await createAccount(ctx.pool, 1_000);
    const other = await createAccount(ctx.pool, 1_000);
    const hold = await holdCash(ctx, [stuck]);
    try {
      // La cuenta trabada reintenta 15 veces mientras su saldo sigue retenido.
      const retries = Array.from({ length: 15 }, () => order(ctx, stuck));
      await until(async () => (await hold.blocked()) === 2, 'dos órdenes esperando el saldo');

      assert.deepEqual(ctx.admission.snapshot(), { inFlight: 15, busyAccounts: 1 });
      assert.equal(busyConnections(ctx), 2, 'las otras 13 esperan en memoria, sin conexión');
      assert.equal(ctx.pool.waitingCount, 0);

      const [placed, portfolio, ready] = await Promise.all([
        order(ctx, other),
        get(ctx.app, `/users/${other}/portfolio`),
        get(ctx.app, '/health/ready'),
      ]);
      assert.equal(placed.status, 201);
      assert.equal(placed.body.status, 'FILLED');
      assert.equal(portfolio.status, 200);
      assert.equal(ready.status, 200);

      await hold.release();
      assert.deepEqual(httpStatuses(await Promise.all(retries)), { '201': 15 });
    } finally {
      await hold.release();
    }
    assert.deepEqual(await cashOf(ctx.pool, stuck), { available: 100, reserved: 0 });
    assert.deepEqual(ctx.admission.snapshot(), { inFlight: 0, busyAccounts: 0 });
  });

  it('con 2 trabajando y 20 esperando, el pedido 23 recibe 429 y se puede reintentar', async () => {
    const userId = await createAccount(ctx.pool, 10_000);
    const keys = Array.from({ length: 23 }, () => randomUUID());
    const hold = await holdCash(ctx, [userId]);
    let responses: AnyResponse[];
    try {
      const pending = keys.map((key) => order(ctx, userId, key));
      // Mientras el saldo sigue retenido, el único que puede responder es el rechazado.
      const refused = await Promise.race(pending);

      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.code, 'TOO_MANY_REQUESTS');
      assert.equal(refused.headers['retry-after'], '1');
      assert.equal((await tradesOf(ctx.pool, userId)).length, 0);
      assert.deepEqual(ctx.admission.snapshot(), { inFlight: 22, busyAccounts: 1 });

      const line = refusalLog(ctx, refused);
      assert.equal(line.event, 'request.refused');
      assert.equal(line.level, INFO);
      assert.equal(line.code, 'TOO_MANY_REQUESTS');
      assert.equal(line.status, 429);

      await hold.release();
      responses = await Promise.all(pending);
    } finally {
      await hold.release();
    }
    assert.deepEqual(httpStatuses(responses), { '201': 22, '429': 1 });

    // El rechazo no consumió la key: el mismo pedido, reenviado, crea la orden que faltaba.
    const refusedKey = keys[responses.findIndex((response) => response.status === 429)];
    const retried = await order(ctx, userId, refusedKey);
    assert.equal(retried.status, 201);
    assert.equal(retried.headers['idempotent-replayed'], undefined);
    assert.equal((await tradesOf(ctx.pool, userId)).length, 23);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 10_000 - 23 * 60, reserved: 0 });
  });

  it('la cola es de cada instancia y no decide nada: con dos instancias el saldo se respeta igual', async () => {
    const userId = await createAccount(ctx.pool, 479); // alcanza para 7
    const secondInstance = await ctx.startAnotherInstance();

    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        placeOrder(index % 2 === 0 ? ctx.app : secondInstance, userId, buyOne),
      ),
    );

    assert.deepEqual(httpStatuses(responses), { '201': 40 });
    assert.deepEqual(
      countBy(responses, (r) => r.body.status),
      { FILLED: 7, REJECTED: 33 },
    );
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 59, reserved: 0 });
  });
});

describe('todas las operaciones de una cuenta comparten su cola (1 a la vez, 2 esperando)', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext({ ACCOUNT_MAX_CONCURRENT: '1', ACCOUNT_MAX_QUEUED: '2' });
  });
  after(() => ctx?.close({ verifyBalances: true }));

  it('con la cola llena, órdenes, cancelaciones y portfolio de esa cuenta reciben 429', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const other = await createAccount(ctx.pool, 1_000);
    const pendingLimit = await placeOrder(ctx.app, userId, limitBuy);
    const hold = await holdCash(ctx, [userId]);
    try {
      const admitted = Array.from({ length: 3 }, () => order(ctx, userId));
      await until(async () => (await hold.blocked()) === 1, 'una orden esperando el saldo');
      await until(() => ctx.admission.snapshot().inFlight === 3, 'tres pedidos admitidos');
      assert.equal(busyConnections(ctx), 1);

      const refused = await Promise.all([
        order(ctx, userId),
        cancelOrder<OrderJson & ErrorJson>(ctx.app, userId, pendingLimit.body.id),
        get<ErrorJson>(ctx.app, `/users/${userId}/portfolio`),
      ]);
      for (const response of refused) {
        assert.equal(response.status, 429);
        assert.equal(response.body.error.code, 'TOO_MANY_REQUESTS');
        assert.deepEqual(response.body.error.details, { userId });
        assert.equal(response.headers['retry-after'], '1');
      }

      // La cola llena es de esa cuenta: otra cuenta opera con normalidad.
      const [placed, portfolio] = await Promise.all([
        order(ctx, other),
        get(ctx.app, `/users/${other}/portfolio`),
      ]);
      assert.equal(placed.status, 201);
      assert.equal(portfolio.status, 200);

      await hold.release();
      assert.deepEqual(httpStatuses(await Promise.all(admitted)), { '201': 3 });
    } finally {
      await hold.release();
    }

    // La cancelación rechazada no cambió nada; ahora que hay lugar, funciona.
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 720, reserved: 100 });
    const cancelled = await cancelOrder(ctx.app, userId, pendingLimit.body.id);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'CANCELLED');
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 820, reserved: 0 });
  });

  it('un pedido inválido se rechaza por inválido, aunque la cola de la cuenta esté llena', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const hold = await holdCash(ctx, [userId]);
    try {
      const admitted = Array.from({ length: 3 }, () => order(ctx, userId));
      await until(() => ctx.admission.snapshot().inFlight === 3, 'tres pedidos admitidos');

      const withoutKey = await placeOrder<ErrorJson>(ctx.app, userId, buyOne, null);
      const badBody = await placeOrder<ErrorJson>(ctx.app, userId, { ...buyOne, size: 0 });
      assert.equal(withoutKey.status, 400);
      assert.equal(badBody.status, 400);

      await hold.release();
      await Promise.all(admitted);
    } finally {
      await hold.release();
    }
  });
});

describe('plazo de espera del turno (150 ms)', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext({ ACCOUNT_MAX_WAIT_MS: '150' }, { captureLogs: true });
  });
  after(() => ctx?.close({ verifyBalances: true }));

  it('si el turno no llega a tiempo → 503 ACCOUNT_BUSY, sin haber hecho nada', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const pendingLimit = await placeOrder(ctx.app, userId, limitBuy);
    const hold = await holdCash(ctx, [userId]);
    let running: Promise<AnyResponse>[];
    try {
      running = [order(ctx, userId), order(ctx, userId)];
      await until(async () => (await hold.blocked()) === 2, 'dos órdenes esperando el saldo');
      // Estos tres esperan turno detrás de las dos órdenes trabadas.
      const waiting = await Promise.all([
        order(ctx, userId),
        cancelOrder<OrderJson & ErrorJson>(ctx.app, userId, pendingLimit.body.id),
        get<ErrorJson>(ctx.app, `/users/${userId}/portfolio`),
      ]);

      for (const response of waiting) {
        assert.equal(response.status, 503);
        assert.equal(response.body.error.code, 'ACCOUNT_BUSY');
        assert.equal(response.headers['retry-after'], '1');
        const line = refusalLog(ctx, response);
        assert.equal(line.event, 'request.unavailable');
        assert.equal(line.level, WARN);
        assert.equal(line.reason, 'account_turn_timeout');
        assert.equal(JSON.stringify(response.body).includes('account_turn_timeout'), false);
      }
      // Los vencidos dejaron su lugar: quedan en curso solo las dos órdenes trabadas.
      assert.deepEqual(ctx.admission.snapshot(), { inFlight: 2, busyAccounts: 1 });
      assert.equal((await tradesOf(ctx.pool, userId)).length, 1, 'solo la LIMIT previa');

      await hold.release();
      assert.deepEqual(httpStatuses(await Promise.all(running)), { '201': 2 });
    } finally {
      await hold.release();
    }

    // La cancelación vencida no llegó a ejecutarse: la orden sigue pendiente y se puede cancelar.
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 780, reserved: 100 });
    const cancelled = await cancelOrder(ctx.app, userId, pendingLimit.body.id);
    assert.equal(cancelled.body.status, 'CANCELLED');
    assert.deepEqual(ctx.admission.snapshot(), { inFlight: 0, busyAccounts: 0 });
  });
});

describe('tope global de pedidos en curso (4)', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext({ MAX_IN_FLIGHT_REQUESTS: '4' }, { captureLogs: true });
  });
  after(() => ctx?.close({ verifyBalances: true }));

  it('con el tope alcanzado, lo nuevo recibe 503 en el momento; al liberarse, vuelve a atender', async () => {
    const busy = await Promise.all(Array.from({ length: 4 }, () => createAccount(ctx.pool, 1_000)));
    const newcomer = await createAccount(ctx.pool, 1_000);
    const pendingLimit = await placeOrder(ctx.app, newcomer, limitBuy);
    const hold = await holdCash(ctx, busy);
    try {
      const inFlight = busy.map((userId) => order(ctx, userId));
      await until(async () => (await hold.blocked()) === 4, 'cuatro órdenes esperando su saldo');

      const refused = await Promise.all([
        order(ctx, newcomer),
        cancelOrder<OrderJson & ErrorJson>(ctx.app, newcomer, pendingLimit.body.id),
        get<ErrorJson>(ctx.app, `/users/${newcomer}/portfolio`),
        get<ErrorJson>(ctx.app, '/instruments?q=pampa'),
      ]);
      for (const response of refused) {
        assert.equal(response.status, 503);
        assert.equal(response.body.error.code, 'SERVER_BUSY');
        assert.equal(response.headers['retry-after'], '1');
        const line = refusalLog(ctx, response);
        assert.equal(line.event, 'request.unavailable');
        assert.equal(line.level, WARN);
        assert.equal(line.reason, 'in_flight_limit');
      }
      assert.equal((await tradesOf(ctx.pool, newcomer)).length, 1, 'solo la LIMIT previa');
      assert.equal(busyConnections(ctx), 4, 'los rechazados no llegaron a pedir conexión');

      // Lo que no trabaja contra la base por un caso de uso queda fuera del tope.
      const [live, ready, docs, invalid, missing] = await Promise.all([
        get(ctx.app, '/health/live'),
        get(ctx.app, '/health/ready'),
        get(ctx.app, '/docs/json'),
        placeOrder<ErrorJson>(ctx.app, newcomer, buyOne, null),
        get<ErrorJson>(ctx.app, '/no-existe'),
      ]);
      assert.deepEqual(
        [live.status, ready.status, docs.status, invalid.status, missing.status],
        [200, 200, 200, 400, 404],
      );

      await hold.release();
      assert.deepEqual(httpStatuses(await Promise.all(inFlight)), { '201': 4 });
    } finally {
      await hold.release();
    }

    assert.deepEqual(ctx.admission.snapshot(), { inFlight: 0, busyAccounts: 0 });
    const [placed, found] = await Promise.all([
      order(ctx, newcomer),
      get(ctx.app, '/instruments?q=pampa'),
    ]);
    assert.equal(placed.status, 201);
    assert.equal(found.status, 200);
    await assertBalancesMatchLedger(ctx.pool);
  });

  it('los pedidos que esperan turno también ocupan plaza en el tope global', async () => {
    const hot = await createAccount(ctx.pool, 1_000);
    const other = await createAccount(ctx.pool, 1_000);
    const hold = await holdCash(ctx, [hot]);
    try {
      // 2 trabajando + 2 esperando: las 4 plazas de esta instancia son de una sola cuenta.
      // Por eso el tope global va muy por encima de lo que admite una cuenta (500 contra 22).
      const admitted = Array.from({ length: 4 }, () => order(ctx, hot));
      await until(() => ctx.admission.snapshot().inFlight === 4, 'cuatro pedidos admitidos');

      const refused = await order(ctx, other);
      assert.equal(refused.status, 503);
      assert.equal(refused.body.error.code, 'SERVER_BUSY');

      await hold.release();
      assert.deepEqual(httpStatuses(await Promise.all(admitted)), { '201': 4 });
    } finally {
      await hold.release();
    }
  });
});
