import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  type ApiResponse,
  assertBalancesMatchLedger,
  balanceOf,
  cancelOrder,
  cashOf,
  countBy,
  createAccount,
  holdShares,
  type OrderJson,
  placeOrder,
  SEED,
  tradesOf,
} from '../helpers/actions.ts';
import { createTestContext, type TestContext } from '../helpers/test-context.ts';

const { POLL, DYCA } = SEED;

const statuses = (responses: ApiResponse<OrderJson>[]) =>
  countBy(responses, (response) => response.body.status);

const httpStatuses = (responses: ApiResponse<unknown>[]) =>
  countBy(responses, (response) => String(response.status));

/**
 * Cada test dispara los pedidos sin esperar a ninguno (`Promise.all`): llegan a Postgres
 * por conexiones distintas y compiten de verdad por las mismas filas.
 *
 * Lo que se prueba acá es el arbitraje de Postgres, así que la cola por cuenta de la API se
 * abre de par en par: todos los pedidos de una cuenta entran a la base a la vez. Es el caso
 * real con varias instancias, donde la cola de cada una no limita lo que llega a la base.
 * La cola misma se prueba en `admission.test.ts`.
 */
const WITHOUT_ACCOUNT_QUEUE = { ACCOUNT_MAX_CONCURRENT: '1000' };

describe('concurrencia sobre una misma cuenta', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext(WITHOUT_ACCOUNT_QUEUE);
  });
  after(() => ctx?.close());

  describe('escenario 1: muchas compras simultáneas contra el mismo saldo', () => {
    it('20 compras iguales con saldo para 7: se ejecutan exactamente 7', async () => {
      // 7 × $60 = $420. Con $479 alcanza para 7 y sobran $59, que no pagan una octava.
      const userId = await createAccount(ctx.pool, 479);

      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          placeOrder(ctx.app, userId, {
            instrumentId: POLL.id,
            side: 'BUY',
            type: 'MARKET',
            size: 1,
          }),
        ),
      );

      assert.deepEqual(httpStatuses(responses), { '201': 20 });
      assert.deepEqual(statuses(responses), { FILLED: 7, REJECTED: 13 });
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 59, reserved: 0 });
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 7, reserved: 0 });
      assert.equal((await tradesOf(ctx.pool, userId)).length, 20);
      await assertBalancesMatchLedger(ctx.pool);
    });

    it('20 compras de 20 acciones distintas: nunca se gasta más de lo que hay', async () => {
      const { rows: instruments } = await ctx.pool.query<{ id: number; close: string }>(
        `SELECT DISTINCT ON (instrumentid) instrumentid AS id, close
         FROM marketdata
         ORDER BY instrumentid, date DESC
         LIMIT 20`,
      );
      assert.equal(instruments.length, 20);
      const totalCost = instruments.reduce((sum, instrument) => sum + Number(instrument.close), 0);
      const funds = Math.floor(totalCost / 2); // alcanza para algunas, no para todas
      const userId = await createAccount(ctx.pool, funds);

      const responses = await Promise.all(
        instruments.map((instrument) =>
          placeOrder(ctx.app, userId, {
            instrumentId: instrument.id,
            side: 'BUY',
            type: 'MARKET',
            size: 1,
          }),
        ),
      );

      const filled = responses.filter((response) => response.body.status === 'FILLED');
      const rejected = responses.filter((response) => response.body.status === 'REJECTED');
      assert.equal(filled.length + rejected.length, 20);
      assert.ok(filled.length > 0, 'alguna tiene que haberse ejecutado');
      assert.ok(rejected.length > 0, 'alguna tiene que haberse rechazado');

      const spentCents = filled.reduce((sum, r) => sum + Math.round(r.body.total * 100), 0);
      const cash = await cashOf(ctx.pool, userId);
      assert.ok(spentCents <= funds * 100, 'se gastó más de lo disponible');
      assert.equal(Math.round(cash.available * 100), funds * 100 - spentCents);
      assert.ok(cash.available >= 0);
      // El saldo solo baja: si una orden se rechazó, tampoco entra en lo que quedó al final.
      for (const response of rejected) {
        assert.ok(response.body.total > cash.available, 'se rechazó una orden que entraba');
        assert.equal(response.body.rejectionReason, 'INSUFFICIENT_FUNDS');
      }
      await assertBalancesMatchLedger(ctx.pool);
    });

    it('10 LIMIT que reservan el 60 % del saldo cada una: entra una sola', async () => {
      const userId = await createAccount(ctx.pool, 1_000);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          placeOrder(ctx.app, userId, {
            instrumentId: POLL.id,
            side: 'BUY',
            type: 'LIMIT',
            size: 12,
            price: 50, // $600
          }),
        ),
      );

      assert.deepEqual(statuses(responses), { NEW: 1, REJECTED: 9 });
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 400, reserved: 600 });
      await assertBalancesMatchLedger(ctx.pool);
    });

    it('MARKET y LIMIT mezcladas compiten por el mismo saldo', async () => {
      const userId = await createAccount(ctx.pool, 600); // alcanza para 10 de $60
      const order = (type: 'MARKET' | 'LIMIT') =>
        placeOrder(ctx.app, userId, {
          instrumentId: POLL.id,
          side: 'BUY',
          type,
          size: 1,
          ...(type === 'LIMIT' ? { price: 60 } : {}),
        });

      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, index) => order(index % 2 === 0 ? 'MARKET' : 'LIMIT')),
      );

      const accepted = responses.filter((r) => r.body.status !== 'REJECTED');
      assert.equal(accepted.length, 10);
      const cash = await cashOf(ctx.pool, userId);
      assert.equal(cash.available, 0);
      assert.equal(cash.reserved, 60 * accepted.filter((r) => r.body.status === 'NEW').length);
      await assertBalancesMatchLedger(ctx.pool);
    });
  });

  describe('escenario 2: vender las mismas acciones desde dos dispositivos', () => {
    it('dos ventas MARKET de las mismas 100 acciones: se ejecuta una', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 100);
      const sellAll = () =>
        placeOrder(ctx.app, userId, {
          instrumentId: POLL.id,
          side: 'SELL',
          type: 'MARKET',
          size: 100,
        });

      const responses = await Promise.all([sellAll(), sellAll()]);

      assert.deepEqual(statuses(responses), { FILLED: 1, REJECTED: 1 });
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 0, reserved: 0 });
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 6_000, reserved: 0 });
      await assertBalancesMatchLedger(ctx.pool);
    });

    it('dos ventas LIMIT de las mismas 100 acciones: queda pendiente una', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 100);
      const sellAll = () =>
        placeOrder(ctx.app, userId, {
          instrumentId: POLL.id,
          side: 'SELL',
          type: 'LIMIT',
          size: 100,
          price: 70,
        });

      const responses = await Promise.all([sellAll(), sellAll()]);

      assert.deepEqual(statuses(responses), { NEW: 1, REJECTED: 1 });
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), {
        available: 0,
        reserved: 100,
      });
      await assertBalancesMatchLedger(ctx.pool);
    });

    it('25 ventas de 10 acciones con 100 en cartera: se ejecutan 10', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 100);

      const responses = await Promise.all(
        Array.from({ length: 25 }, () =>
          placeOrder(ctx.app, userId, {
            instrumentId: POLL.id,
            side: 'SELL',
            type: 'MARKET',
            size: 10,
          }),
        ),
      );

      assert.deepEqual(statuses(responses), { FILLED: 10, REJECTED: 15 });
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 0, reserved: 0 });
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 6_000, reserved: 0 });
      await assertBalancesMatchLedger(ctx.pool);
    });
  });

  describe('compras y ventas cruzadas', () => {
    it('comprar y vender el mismo activo a la vez no produce deadlocks', async () => {
      // Una compra toca pesos y después acciones; una venta, acciones y después pesos.
      // Sin un orden único de locks, este cruce se traba.
      const userId = await createAccount(ctx.pool, 6_000);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 100);
      const trade = (side: 'BUY' | 'SELL') =>
        placeOrder(ctx.app, userId, { instrumentId: POLL.id, side, type: 'MARKET', size: 1 });

      const responses = await Promise.all(
        Array.from({ length: 60 }, (_, index) => trade(index % 2 === 0 ? 'BUY' : 'SELL')),
      );

      // Hay saldo y acciones de sobra para las 60: todas se ejecutan y el neto es cero.
      assert.deepEqual(httpStatuses(responses), { '201': 60 });
      assert.deepEqual(statuses(responses), { FILLED: 60 });
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 6_000, reserved: 0 });
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), {
        available: 100,
        reserved: 0,
      });
      await assertBalancesMatchLedger(ctx.pool);
    });

    it('operar dos activos a la vez con el mismo saldo', async () => {
      const userId = await createAccount(ctx.pool, 1_000);
      const buy = (instrument: { id: number }) =>
        placeOrder(ctx.app, userId, {
          instrumentId: instrument.id,
          side: 'BUY',
          type: 'MARKET',
          size: 1,
        });

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) => buy(index % 2 === 0 ? POLL : DYCA)),
      );

      const spent = responses
        .filter((r) => r.body.status === 'FILLED')
        .reduce((sum, r) => sum + r.body.total, 0);
      const cash = await cashOf(ctx.pool, userId);
      assert.equal(cash.available, 1_000 - spent);
      assert.ok(cash.available >= 0 && cash.available < DYCA.close);
      await assertBalancesMatchLedger(ctx.pool);
    });
  });

  describe('cuentas distintas no se estorban', () => {
    it('cada cuenta ejecuta exactamente lo que su saldo permite', async () => {
      const users = await Promise.all([
        createAccount(ctx.pool, 180), // 3 de $60
        createAccount(ctx.pool, 300), // 5
        createAccount(ctx.pool, 0), // 0
      ]);

      const responses = await Promise.all(
        users.flatMap((userId) =>
          Array.from({ length: 8 }, () =>
            placeOrder(ctx.app, userId, {
              instrumentId: POLL.id,
              side: 'BUY',
              type: 'MARKET',
              size: 1,
            }),
          ),
        ),
      );

      const filledBy = countBy(
        responses.filter((r) => r.body.status === 'FILLED'),
        (r) => String(r.body.userId),
      );
      assert.deepEqual(filledBy, { [String(users[0])]: 3, [String(users[1])]: 5 });
      await assertBalancesMatchLedger(ctx.pool);
    });
  });

  describe('cancelaciones simultáneas', () => {
    it('10 cancelaciones de la misma orden: una la cancela y la reserva se libera una vez', async () => {
      const userId = await createAccount(ctx.pool, 1_000);
      const order = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 10,
        price: 50,
      });
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 500, reserved: 500 });

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => cancelOrder(ctx.app, userId, order.body.id)),
      );

      assert.deepEqual(httpStatuses(responses), { '200': 10 });
      assert.deepEqual(statuses(responses), { CANCELLED: 10 });
      // Si la reserva se liberara más de una vez, habría más de $1.000 disponibles.
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 1_000, reserved: 0 });
      await assertBalancesMatchLedger(ctx.pool);
    });

    it('cancelar varias órdenes distintas a la vez libera cada reserva', async () => {
      const userId = await createAccount(ctx.pool, 1_000);
      const orders = [];
      for (let index = 0; index < 5; index++) {
        orders.push(
          await placeOrder(ctx.app, userId, {
            instrumentId: POLL.id,
            side: 'BUY',
            type: 'LIMIT',
            size: 2,
            price: 50,
          }),
        );
      }
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 500, reserved: 500 });

      // Cada orden recibe 3 pedidos de cancelación al mismo tiempo.
      const responses = await Promise.all(
        orders.flatMap((order) =>
          Array.from({ length: 3 }, () => cancelOrder(ctx.app, userId, order.body.id)),
        ),
      );

      assert.deepEqual(httpStatuses(responses), { '200': 15 });
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 1_000, reserved: 0 });
      await assertBalancesMatchLedger(ctx.pool);
    });

    it('cancelar mientras entra una compra que necesita esos pesos', async () => {
      // La compra se ejecuta solo si la cancelación ya liberó la reserva. Gane quien gane,
      // el saldo queda consistente.
      for (let round = 0; round < 5; round++) {
        const userId = await createAccount(ctx.pool, 600);
        const limit = await placeOrder(ctx.app, userId, {
          instrumentId: POLL.id,
          side: 'BUY',
          type: 'LIMIT',
          size: 10,
          price: 60,
        });

        const [cancelled, market] = await Promise.all([
          cancelOrder(ctx.app, userId, limit.body.id),
          placeOrder(ctx.app, userId, {
            instrumentId: POLL.id,
            side: 'BUY',
            type: 'MARKET',
            size: 10,
          }),
        ]);

        assert.equal(cancelled.body.status, 'CANCELLED');
        const cash = await cashOf(ctx.pool, userId);
        if (market.body.status === 'FILLED') {
          assert.deepEqual(cash, { available: 0, reserved: 0 });
        } else {
          assert.equal(market.body.status, 'REJECTED');
          assert.deepEqual(cash, { available: 600, reserved: 0 });
        }
      }
      await assertBalancesMatchLedger(ctx.pool);
    });
  });
});
