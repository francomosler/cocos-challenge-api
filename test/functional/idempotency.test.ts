import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  cancelOrder,
  cashOf,
  countBy,
  createAccount,
  type ErrorJson,
  fund,
  placeOrder,
  SEED,
  tradesOf,
} from '../helpers/actions.ts';
import { createTestContext, type TestContext } from '../helpers/test-context.ts';

const { POLL } = SEED;
const buyOne = { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', size: 1 };

describe('idempotencia del envío de órdenes (escenario 5: doble tap y reintentos)', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext();
  });
  after(() => ctx?.close({ verifyBalances: true }));

  it('repetir el pedido con la misma key devuelve la orden original y no opera de nuevo', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const key = randomUUID();

    const first = await placeOrder(ctx.app, userId, buyOne, key);
    const second = await placeOrder(ctx.app, userId, buyOne, key);

    assert.equal(first.status, 201);
    assert.equal(first.headers['idempotent-replayed'], undefined);
    assert.equal(second.status, 200);
    assert.equal(second.headers['idempotent-replayed'], 'true');
    assert.deepEqual(second.body, first.body);

    assert.equal((await tradesOf(ctx.pool, userId)).length, 1);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 940, reserved: 0 });
  });

  it('dos compras iguales con keys distintas son dos compras legítimas', async () => {
    const userId = await createAccount(ctx.pool, 1_000);

    const first = await placeOrder(ctx.app, userId, buyOne, randomUUID());
    const second = await placeOrder(ctx.app, userId, buyOne, randomUUID());

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.id, second.body.id);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 880, reserved: 0 });
  });

  it('10 envíos simultáneos con la misma key crean una sola orden', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => placeOrder(ctx.app, userId, buyOne, key)),
    );

    assert.deepEqual(
      countBy(responses, (r) => String(r.status)),
      { '201': 1, '200': 9 },
    );
    assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
    assert.equal((await tradesOf(ctx.pool, userId)).length, 1);
    // Se debitó una sola vez, aunque varias transacciones llegaron a reservar.
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 940, reserved: 0 });
  });

  it('10 envíos simultáneos de una LIMIT con la misma key reservan una sola vez', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const key = randomUUID();
    const limit = { instrumentId: POLL.id, side: 'BUY', type: 'LIMIT', size: 4, price: 50 };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => placeOrder(ctx.app, userId, limit, key)),
    );

    assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 800, reserved: 200 });
  });

  it('la garantía vale entre instancias: el reintento puede caer en otro pod', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const otherInstance = await ctx.startAnotherInstance();
    const key = randomUUID();

    const first = await placeOrder(ctx.app, userId, buyOne, key);
    const retried = await placeOrder(otherInstance, userId, buyOne, key);

    assert.equal(retried.status, 200);
    assert.equal(retried.headers['idempotent-replayed'], 'true');
    assert.equal(retried.body.id, first.body.id);
    assert.equal((await tradesOf(ctx.pool, userId)).length, 1);
  });

  it('la garantía sobrevive a un reinicio: la key está en la base, no en memoria', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const key = randomUUID();
    const beforeRestart = await ctx.startAnotherInstance();
    const first = await placeOrder(beforeRestart, userId, buyOne, key);
    await beforeRestart.close();

    const afterRestart = await ctx.startAnotherInstance();
    const retried = await placeOrder(afterRestart, userId, buyOne, key);

    assert.equal(retried.status, 200);
    assert.equal(retried.body.id, first.body.id);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 940, reserved: 0 });
  });

  it('envíos simultáneos repartidos entre dos instancias: una sola orden', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const otherInstance = await ctx.startAnotherInstance();
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        placeOrder(index % 2 === 0 ? ctx.app : otherInstance, userId, buyOne, key),
      ),
    );

    assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
    assert.equal((await tradesOf(ctx.pool, userId)).length, 1);
  });

  it('misma key con un pedido distinto → 422, sin crear nada', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const key = randomUUID();
    const first = await placeOrder(ctx.app, userId, buyOne, key);

    for (const different of [
      { ...buyOne, size: 2 },
      { ...buyOne, side: 'SELL' },
      { ...buyOne, instrumentId: SEED.DYCA.id },
      { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', amount: 60 },
      { instrumentId: POLL.id, side: 'BUY', type: 'LIMIT', size: 1, price: 60 },
    ]) {
      const response = await placeOrder<ErrorJson>(ctx.app, userId, different, key);
      assert.equal(response.status, 422, JSON.stringify(different));
      assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
      assert.deepEqual(response.body.error.details, { orderId: first.body.id });
    }

    assert.equal((await tradesOf(ctx.pool, userId)).length, 1);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 940, reserved: 0 });
  });

  it('la key es por usuario: dos cuentas pueden usar la misma', async () => {
    const [alice, bob] = await Promise.all([
      createAccount(ctx.pool, 1_000),
      createAccount(ctx.pool, 1_000),
    ]);
    const key = randomUUID();

    const first = await placeOrder(ctx.app, alice, buyOne, key);
    const second = await placeOrder(ctx.app, bob, buyOne, key);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.id, second.body.id);
    assert.equal(second.body.userId, bob);
  });

  it('un rechazo también es definitivo: reintentar no vuelve a evaluar el saldo', async () => {
    const userId = await createAccount(ctx.pool);
    const key = randomUUID();
    const rejected = await placeOrder(ctx.app, userId, buyOne, key);
    assert.equal(rejected.body.status, 'REJECTED');

    await fund(ctx.pool, userId, 1_000); // ahora sí alcanzaría
    const retried = await placeOrder(ctx.app, userId, buyOne, key);

    assert.equal(retried.status, 200);
    assert.equal(retried.body.status, 'REJECTED');
    assert.equal(retried.body.id, rejected.body.id);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 1_000, reserved: 0 });

    // Una intención nueva (otra key) sí se evalúa con el saldo actual.
    const fresh = await placeOrder(ctx.app, userId, buyOne, randomUUID());
    assert.equal(fresh.body.status, 'FILLED');
  });

  it('un pedido inválido no consume la key', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const key = randomUUID();

    const invalid = await placeOrder<ErrorJson>(ctx.app, userId, { ...buyOne, price: 10 }, key);
    assert.equal(invalid.status, 400);

    const corrected = await placeOrder(ctx.app, userId, buyOne, key);
    assert.equal(corrected.status, 201);
    assert.equal(corrected.body.status, 'FILLED');
  });

  it('reintentar después de cancelar devuelve la orden en su estado actual', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const key = randomUUID();
    const limit = { instrumentId: POLL.id, side: 'BUY', type: 'LIMIT', size: 4, price: 50 };
    const placed = await placeOrder(ctx.app, userId, limit, key);
    await cancelOrder(ctx.app, userId, placed.body.id);

    const retried = await placeOrder(ctx.app, userId, limit, key);

    assert.equal(retried.status, 200);
    assert.equal(retried.body.id, placed.body.id);
    assert.equal(retried.body.status, 'CANCELLED');
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 1_000, reserved: 0 });
  });
});
