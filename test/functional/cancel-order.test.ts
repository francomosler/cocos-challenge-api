import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  balanceOf,
  cancelOrder,
  cashOf,
  createAccount,
  type ErrorJson,
  holdShares,
  placeOrder,
  SEED,
  tradesOf,
} from '../helpers/actions.ts';
import { createTestContext, type TestContext } from '../helpers/test-context.ts';

const { POLL } = SEED;

describe('POST /users/:userId/orders/:orderId/cancel', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext();
  });
  after(() => ctx?.close({ verifyBalances: true }));

  const limitBuy = (userId: number, size: number, price: number) =>
    placeOrder(ctx.app, userId, { instrumentId: POLL.id, side: 'BUY', type: 'LIMIT', size, price });

  it('cancela una LIMIT de compra en NEW y libera los pesos reservados', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const order = await limitBuy(userId, 10, 50);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 500, reserved: 500 });

    const { status, body } = await cancelOrder(ctx.app, userId, order.body.id);

    assert.equal(status, 200);
    assert.equal(body.id, order.body.id);
    assert.equal(body.status, 'CANCELLED');
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 1_000, reserved: 0 });
    assert.equal((await tradesOf(ctx.pool, userId))[0]?.status, 'CANCELLED');
  });

  it('cancela una LIMIT de venta en NEW y libera las acciones reservadas', async () => {
    const userId = await createAccount(ctx.pool);
    await holdShares(ctx.app, ctx.pool, userId, POLL, 10);
    const order = await placeOrder(ctx.app, userId, {
      instrumentId: POLL.id,
      side: 'SELL',
      type: 'LIMIT',
      size: 7,
      price: 80,
    });
    assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 3, reserved: 7 });

    const { status, body } = await cancelOrder(ctx.app, userId, order.body.id);

    assert.equal(status, 200);
    assert.equal(body.status, 'CANCELLED');
    assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 10, reserved: 0 });
  });

  it('lo liberado se puede volver a usar', async () => {
    const userId = await createAccount(ctx.pool, 600);
    const order = await limitBuy(userId, 10, 60);
    const blocked = await placeOrder(ctx.app, userId, {
      instrumentId: POLL.id,
      side: 'BUY',
      type: 'MARKET',
      size: 10,
    });
    assert.equal(blocked.body.status, 'REJECTED');

    await cancelOrder(ctx.app, userId, order.body.id);

    const retried = await placeOrder(ctx.app, userId, {
      instrumentId: POLL.id,
      side: 'BUY',
      type: 'MARKET',
      size: 10,
    });
    assert.equal(retried.body.status, 'FILLED');
  });

  it('cancelar dos veces devuelve la misma orden y libera una sola vez', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const order = await limitBuy(userId, 10, 50);

    const first = await cancelOrder(ctx.app, userId, order.body.id);
    const second = await cancelOrder(ctx.app, userId, order.body.id);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 1_000, reserved: 0 });
  });

  it('cancelar una de dos LIMIT libera solo la suya', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const first = await limitBuy(userId, 4, 50); // reserva 200
    await limitBuy(userId, 6, 50); // reserva 300

    await cancelOrder(ctx.app, userId, first.body.id);

    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 700, reserved: 300 });
  });

  it('no se puede cancelar una orden FILLED', async () => {
    const userId = await createAccount(ctx.pool, 1_000);
    const filled = await placeOrder(ctx.app, userId, {
      instrumentId: POLL.id,
      side: 'BUY',
      type: 'MARKET',
      size: 1,
    });

    const { status, body } = await cancelOrder<ErrorJson>(ctx.app, userId, filled.body.id);

    assert.equal(status, 409);
    assert.equal(body.error.code, 'ORDER_NOT_CANCELLABLE');
    assert.deepEqual(body.error.details, { orderId: filled.body.id, status: 'FILLED' });
    assert.equal((await tradesOf(ctx.pool, userId))[0]?.status, 'FILLED');
    assert.deepEqual(await cashOf(ctx.pool, userId), { available: 940, reserved: 0 });
  });

  it('no se puede cancelar una orden REJECTED', async () => {
    const userId = await createAccount(ctx.pool);
    const rejected = await placeOrder(ctx.app, userId, {
      instrumentId: POLL.id,
      side: 'BUY',
      type: 'MARKET',
      size: 1,
    });
    assert.equal(rejected.body.status, 'REJECTED');

    const { status, body } = await cancelOrder<ErrorJson>(ctx.app, userId, rejected.body.id);

    assert.equal(status, 409);
    assert.equal(body.error.code, 'ORDER_NOT_CANCELLABLE');
  });

  it('una orden que no existe → 404', async () => {
    const userId = await createAccount(ctx.pool);
    const { status, body } = await cancelOrder<ErrorJson>(ctx.app, userId, 999_999);
    assert.equal(status, 404);
    assert.equal(body.error.code, 'ORDER_NOT_FOUND');
  });

  it('un usuario no puede cancelar la orden de otro (y no se entera de que existe)', async () => {
    const owner = await createAccount(ctx.pool, 1_000);
    const intruder = await createAccount(ctx.pool);
    const order = await limitBuy(owner, 10, 50);

    const { status, body } = await cancelOrder<ErrorJson>(ctx.app, intruder, order.body.id);

    assert.equal(status, 404);
    assert.equal(body.error.code, 'ORDER_NOT_FOUND');
    assert.equal((await tradesOf(ctx.pool, owner))[0]?.status, 'NEW');
    assert.deepEqual(await cashOf(ctx.pool, owner), { available: 500, reserved: 500 });
  });

  for (const orderId of ['abc', '0', '-1', '1.5']) {
    it(`orderId "${orderId}" → 400`, async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/users/1/orders/${orderId}/cancel`,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    });
  }

  describe('órdenes que ya venían en la base del challenge', () => {
    it('cancela las dos LIMIT en NEW del usuario 1 y libera lo que reservaban', async () => {
      // Órdenes 5 (50 × $710) y 7 (60 × $1.500): $125.500 reservados en la carga inicial.
      assert.deepEqual(await cashOf(ctx.pool, 1), { available: 627_500, reserved: 125_500 });

      const fifth = await cancelOrder(ctx.app, 1, 5);
      assert.equal(fifth.body.status, 'CANCELLED');
      assert.deepEqual(await cashOf(ctx.pool, 1), { available: 663_000, reserved: 90_000 });

      const seventh = await cancelOrder(ctx.app, 1, 7);
      assert.equal(seventh.body.status, 'CANCELLED');
      assert.deepEqual(await cashOf(ctx.pool, 1), { available: 753_000, reserved: 0 });
    });

    it('la orden 3 ya estaba CANCELLED: se devuelve tal cual', async () => {
      const { status, body } = await cancelOrder(ctx.app, 1, 3);
      assert.equal(status, 200);
      assert.equal(body.status, 'CANCELLED');
    });

    it('la orden 6 estaba REJECTED y la 2 FILLED: no se cancelan', async () => {
      assert.equal((await cancelOrder(ctx.app, 1, 6)).status, 409);
      assert.equal((await cancelOrder(ctx.app, 1, 2)).status, 409);
    });

    it('una transferencia (orden 1, CASH_IN) no se puede cancelar', async () => {
      assert.equal((await cancelOrder(ctx.app, 1, 1)).status, 409);
    });
  });
});
