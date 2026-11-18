import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  cancelOrder,
  cashOf,
  createAccount,
  type ErrorJson,
  get,
  holdShares,
  placeOrder,
  SEED,
} from '../helpers/actions.ts';
import { createTestContext, type TestContext } from '../helpers/test-context.ts';

const { POLL, PAMP, DYCA } = SEED;

interface PositionJson {
  instrumentId: number;
  ticker: string;
  name: string;
  quantity: number;
  reservedQuantity: number;
  averageCost: number;
  lastPrice: number | null;
  marketValue: number | null;
  totalReturnPercent: number | null;
  dailyReturnPercent: number | null;
}

interface PortfolioJson {
  userId: number;
  totalAccountValue: number;
  availableCash: number;
  reservedCash: number;
  positions: PositionJson[];
}

describe('GET /users/:userId/portfolio', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext();
  });
  after(() => ctx?.close({ verifyBalances: true }));

  const portfolioOf = async (userId: number) =>
    (await get<PortfolioJson>(ctx.app, `/users/${userId}/portfolio`)).body;

  describe('con los datos del challenge', () => {
    it('usuario 1: valor de la cuenta, pesos disponibles y posiciones', async () => {
      const { status, body } = await get<PortfolioJson>(ctx.app, '/users/1/portfolio');

      assert.equal(status, 200);
      assert.deepEqual(body, {
        userId: 1,
        // $753.000 en pesos + $114.750 (METR) + $37.034 (PAMP)
        totalAccountValue: 904_784,
        // $753.000 menos $125.500 reservados por dos LIMIT de compra en NEW
        availableCash: 627_500,
        reservedCash: 125_500,
        positions: [
          {
            instrumentId: 54,
            ticker: 'METR',
            name: 'MetroGAS S.A.',
            quantity: 500,
            reservedQuantity: 0,
            averageCost: 250,
            lastPrice: 229.5,
            marketValue: 114_750,
            totalReturnPercent: -8.2,
            dailyReturnPercent: -1.08,
          },
          {
            instrumentId: 47,
            ticker: 'PAMP',
            name: 'Pampa Holding S.A.',
            quantity: 40, // compró 50, vendió 10
            reservedQuantity: 0,
            averageCost: 930,
            lastPrice: 925.85,
            marketValue: 37_034,
            totalReturnPercent: -0.45,
            dailyReturnPercent: 0.44,
          },
        ],
      });
    });

    it('usuario 1: BMA no figura porque el seed la deja sobrevendida (−10)', async () => {
      const { positions } = await portfolioOf(1);
      assert.equal(
        positions.some((position) => position.ticker === 'BMA'),
        false,
      );
    });

    it('usuario sin movimientos: todo en cero', async () => {
      assert.deepEqual(await portfolioOf(2), {
        userId: 2,
        totalAccountValue: 0,
        availableCash: 0,
        reservedCash: 0,
        positions: [],
      });
    });

    it('usuario inexistente → 404', async () => {
      const { status, body } = await get<ErrorJson>(ctx.app, '/users/999999/portfolio');
      assert.equal(status, 404);
      assert.equal(body.error.code, 'USER_NOT_FOUND');
    });

    for (const userId of ['abc', '0', '-1', '1.5', '99999999999']) {
      it(`userId "${userId}" → 400`, async () => {
        const { status, body } = await get<ErrorJson>(ctx.app, `/users/${userId}/portfolio`);
        assert.equal(status, 400);
        assert.equal(body.error.code, 'VALIDATION_ERROR');
      });
    }
  });

  describe('refleja cada orden', () => {
    it('comprar a mercado cambia pesos por acciones: el valor total no se mueve', async () => {
      const userId = await createAccount(ctx.pool, 10_000);

      await placeOrder(ctx.app, userId, {
        instrumentId: PAMP.id,
        side: 'BUY',
        type: 'MARKET',
        size: 4,
      });

      const portfolio = await portfolioOf(userId);
      assert.equal(portfolio.totalAccountValue, 10_000);
      assert.equal(portfolio.availableCash, 6296.6);
      assert.equal(portfolio.reservedCash, 0);
      assert.deepEqual(portfolio.positions, [
        {
          instrumentId: PAMP.id,
          ticker: 'PAMP',
          name: 'Pampa Holding S.A.',
          quantity: 4,
          reservedQuantity: 0,
          averageCost: 925.85,
          lastPrice: 925.85,
          marketValue: 3703.4,
          totalReturnPercent: 0,
          dailyReturnPercent: 0.44,
        },
      ]);
    });

    it('una LIMIT de compra reserva pesos pero no crea posición', async () => {
      const userId = await createAccount(ctx.pool, 10_000);
      await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 50,
        price: 40,
      });

      assert.deepEqual(await portfolioOf(userId), {
        userId,
        totalAccountValue: 10_000, // los pesos reservados siguen siendo del usuario
        availableCash: 8_000,
        reservedCash: 2_000,
        positions: [],
      });
    });

    it('una LIMIT de venta deja las acciones en cartera, marcadas como reservadas', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 10);
      await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'LIMIT',
        size: 6,
        price: 90,
      });

      const [position] = (await portfolioOf(userId)).positions;
      assert.equal(position?.quantity, 10);
      assert.equal(position?.reservedQuantity, 6);
      assert.equal(position?.marketValue, 600);
    });

    it('las órdenes REJECTED y CANCELLED no cuentan', async () => {
      const userId = await createAccount(ctx.pool, 1_000);
      const before = await portfolioOf(userId);

      const rejected = await placeOrder(ctx.app, userId, {
        instrumentId: PAMP.id,
        side: 'BUY',
        type: 'MARKET',
        size: 50,
      });
      assert.equal(rejected.body.status, 'REJECTED');
      const limit = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 5,
        price: 50,
      });
      await cancelOrder(ctx.app, userId, limit.body.id);

      assert.deepEqual(await portfolioOf(userId), before);
    });

    it('vender todo saca la posición del listado', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 5);
      await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'MARKET',
        size: 5,
      });

      assert.deepEqual(await portfolioOf(userId), {
        userId,
        totalAccountValue: 300,
        availableCash: 300,
        reservedCash: 0,
        positions: [],
      });
    });

    it('compras a distinto precio promedian el costo y muestran ganancia o pérdida', async () => {
      const userId = await createAccount(ctx.pool, 10_000);
      // Una compra histórica a $40 (cargada directo, como las del seed) y otra hoy a $60.
      await ctx.pool.query(
        `INSERT INTO orders (instrumentid, userid, size, price, type, side, status, datetime)
         VALUES ($1, $2, 10, 40, 'LIMIT', 'BUY', 'FILLED', '2023-07-10 10:00:00')`,
        [POLL.id, userId],
      );
      await ctx.pool.query(
        `UPDATE balances SET available = available - 400 WHERE userid = $1 AND instrumentid = $2`,
        [userId, SEED.ARS],
      );
      await ctx.pool.query(
        'INSERT INTO balances (userid, instrumentid, available) VALUES ($1, $2, 10)',
        [userId, POLL.id],
      );
      await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'MARKET',
        size: 30,
      });

      const portfolio = await portfolioOf(userId);
      const [position] = portfolio.positions;
      assert.equal(position?.quantity, 40);
      assert.equal(position?.averageCost, 55); // (10 × 40 + 30 × 60) / 40
      assert.equal(position?.marketValue, 2_400);
      assert.equal(position?.totalReturnPercent, 9.09); // 2400 contra 2200
      assert.equal(portfolio.availableCash, 7_800);
      assert.equal(portfolio.totalAccountValue, 10_200); // ganó $200
    });

    it('lista varias posiciones ordenadas por ticker', async () => {
      const userId = await createAccount(ctx.pool, 10_000);
      for (const instrument of [POLL, DYCA, PAMP]) {
        await placeOrder(ctx.app, userId, {
          instrumentId: instrument.id,
          side: 'BUY',
          type: 'MARKET',
          size: 1,
        });
      }
      const tickers = (await portfolioOf(userId)).positions.map((position) => position.ticker);
      assert.deepEqual(tickers, ['DYCA', 'PAMP', 'POLL']);
    });

    it('los pesos disponibles del portfolio (desde orders) coinciden con balances', async () => {
      const userId = await createAccount(ctx.pool, 5_000);
      await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'MARKET',
        size: 7,
      });
      await placeOrder(ctx.app, userId, {
        instrumentId: DYCA.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 3,
        price: 200.5,
      });
      await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'MARKET',
        size: 2,
      });

      const portfolio = await portfolioOf(userId);
      const cash = await cashOf(ctx.pool, userId);
      assert.equal(portfolio.availableCash, cash.available);
      assert.equal(portfolio.reservedCash, cash.reserved);
    });
  });
});
