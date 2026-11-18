import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  balanceOf,
  cashOf,
  countOrders,
  createAccount,
  type ErrorJson,
  holdShares,
  type OrderBody,
  placeOrder,
  SEED,
  tradesOf,
} from '../helpers/actions.ts';
import { createTestContext, type TestContext } from '../helpers/test-context.ts';

const { POLL, DYCA, PAMP, BMA } = SEED;

describe('POST /users/:userId/orders', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext();
  });
  after(() => ctx?.close({ verifyBalances: true }));

  describe('órdenes MARKET', () => {
    it('compra por cantidad: queda FILLED al último close y mueve pesos y acciones', async () => {
      const userId = await createAccount(ctx.pool, 10_000);

      const { status, body } = await placeOrder(ctx.app, userId, {
        instrumentId: PAMP.id,
        side: 'BUY',
        type: 'MARKET',
        size: 3,
      });

      assert.equal(status, 201);
      assert.equal(body.status, 'FILLED');
      assert.equal(body.type, 'MARKET');
      assert.equal(body.side, 'BUY');
      assert.equal(body.size, 3);
      assert.equal(body.price, 925.85);
      assert.equal(body.total, 2777.55);
      assert.equal(body.rejectionReason, null);
      assert.equal(body.userId, userId);

      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 7222.45, reserved: 0 });
      assert.deepEqual(await balanceOf(ctx.pool, userId, PAMP.id), { available: 3, reserved: 0 });
    });

    it('la orden queda grabada en la tabla orders con sus valores', async () => {
      const userId = await createAccount(ctx.pool, 1_000);
      const { body } = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'MARKET',
        size: 2,
      });

      const { rows } = await ctx.pool.query('SELECT * FROM orders WHERE id = $1', [body.id]);
      const row = rows[0];
      assert.equal(row.userid, userId);
      assert.equal(row.instrumentid, POLL.id);
      assert.equal(row.side, 'BUY');
      assert.equal(row.type, 'MARKET');
      assert.equal(row.status, 'FILLED');
      assert.equal(row.size, 2);
      assert.equal(row.price, '60.00');
      assert.equal(row.rejection_reason, null);
      const ageMs = Date.now() - (row.datetime as Date).getTime();
      assert.ok(ageMs >= 0 && ageMs < 10_000, `datetime debería ser "ahora" en UTC (${ageMs} ms)`);
    });

    it('compra por monto: opera la mayor cantidad entera y no usa el resto', async () => {
      const userId = await createAccount(ctx.pool, 10_000);

      const { status, body } = await placeOrder(ctx.app, userId, {
        instrumentId: PAMP.id,
        side: 'BUY',
        type: 'MARKET',
        amount: 5_000, // 5000 / 925,85 = 5,4 → 5 acciones
      });

      assert.equal(status, 201);
      assert.equal(body.status, 'FILLED');
      assert.equal(body.size, 5);
      assert.equal(body.total, 4629.25);
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 5370.75, reserved: 0 });
    });

    it('compra por monto con decimales', async () => {
      const userId = await createAccount(ctx.pool, 1_000);
      const { body } = await placeOrder(ctx.app, userId, {
        instrumentId: SEED.DOME.id,
        side: 'BUY',
        type: 'MARKET',
        amount: 102.49, // 102,49 / 20,50 = 4,99 → 4 acciones
      });
      assert.equal(body.size, 4);
      assert.equal(body.total, 82);
    });

    it('venta por cantidad: entrega acciones y acredita pesos', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 10);

      const { status, body } = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'MARKET',
        size: 4,
      });

      assert.equal(status, 201);
      assert.equal(body.status, 'FILLED');
      assert.equal(body.total, 240);
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 240, reserved: 0 });
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 6, reserved: 0 });
    });

    it('venta por monto: vende las acciones enteras que cubren ese monto', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 10);

      const { body } = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'MARKET',
        amount: 200, // 200 / 60 = 3,33 → 3 acciones
      });

      assert.equal(body.status, 'FILLED');
      assert.equal(body.size, 3);
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 7, reserved: 0 });
    });

    it('se puede comprar justo con todo el saldo', async () => {
      const userId = await createAccount(ctx.pool, 420);
      const { body } = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'MARKET',
        size: 7, // 7 × 60 = 420
      });
      assert.equal(body.status, 'FILLED');
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 0, reserved: 0 });
    });

    it('se puede vender toda la tenencia', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 5);
      const { body } = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'MARKET',
        size: 5,
      });
      assert.equal(body.status, 'FILLED');
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 0, reserved: 0 });
    });
  });

  describe('órdenes LIMIT', () => {
    it('compra: queda NEW al precio pedido y reserva los pesos', async () => {
      const userId = await createAccount(ctx.pool, 10_000);

      const { status, body } = await placeOrder(ctx.app, userId, {
        instrumentId: PAMP.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 4,
        price: 900.5,
      });

      assert.equal(status, 201);
      assert.equal(body.status, 'NEW');
      assert.equal(body.type, 'LIMIT');
      assert.equal(body.price, 900.5);
      assert.equal(body.total, 3602);
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 6398, reserved: 3602 });
      // No se ejecutó: todavía no hay acciones.
      assert.deepEqual(await balanceOf(ctx.pool, userId, PAMP.id), { available: 0, reserved: 0 });
    });

    it('compra por monto: la cantidad sale del precio límite, no del de mercado', async () => {
      const userId = await createAccount(ctx.pool, 10_000);
      const { body } = await placeOrder(ctx.app, userId, {
        instrumentId: PAMP.id,
        side: 'BUY',
        type: 'LIMIT',
        amount: 5_000,
        price: 400, // 5000 / 400 = 12 (a mercado serían 5)
      });
      assert.equal(body.status, 'NEW');
      assert.equal(body.size, 12);
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 5_200, reserved: 4_800 });
    });

    it('venta: queda NEW y reserva las acciones', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 10);

      const { status, body } = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'LIMIT',
        size: 6,
        price: 75,
      });

      assert.equal(status, 201);
      assert.equal(body.status, 'NEW');
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 4, reserved: 6 });
      // Los pesos no se acreditan hasta que se ejecute.
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 0, reserved: 0 });
    });

    it('se puede dejar una LIMIT sobre un instrumento sin precio de mercado', async () => {
      const userId = await createAccount(ctx.pool, 1_000);
      const { status, body } = await placeOrder(ctx.app, userId, {
        instrumentId: SEED.withoutPrice[0],
        side: 'BUY',
        type: 'LIMIT',
        size: 2,
        price: 100,
      });
      assert.equal(status, 201);
      assert.equal(body.status, 'NEW');
    });
  });

  describe('rechazos por saldo: la orden se graba como REJECTED', () => {
    it('compra por más pesos de los disponibles', async () => {
      const userId = await createAccount(ctx.pool, 925); // PAMP vale 925,85

      const { status, body } = await placeOrder(ctx.app, userId, {
        instrumentId: PAMP.id,
        side: 'BUY',
        type: 'MARKET',
        size: 1,
      });

      assert.equal(status, 201);
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.rejectionReason, 'INSUFFICIENT_FUNDS');
      assert.equal(body.price, 925.85);
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 925, reserved: 0 });
      assert.deepEqual(await balanceOf(ctx.pool, userId, PAMP.id), { available: 0, reserved: 0 });

      const [stored] = await tradesOf(ctx.pool, userId);
      assert.equal(stored?.status, 'REJECTED');
      assert.equal(stored?.rejection_reason, 'INSUFFICIENT_FUNDS');
    });

    it('compra de una cuenta que nunca tuvo pesos', async () => {
      const userId = await createAccount(ctx.pool);
      const { body } = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'MARKET',
        size: 1,
      });
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.rejectionReason, 'INSUFFICIENT_FUNDS');
    });

    it('venta por más acciones de las que tiene', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 5);

      const { status, body } = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'MARKET',
        size: 6,
      });

      assert.equal(status, 201);
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.rejectionReason, 'INSUFFICIENT_SHARES');
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 5, reserved: 0 });
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 0, reserved: 0 });
    });

    it('venta de un instrumento que no tiene (no hay venta en corto)', async () => {
      const userId = await createAccount(ctx.pool, 100_000);
      const { body } = await placeOrder(ctx.app, userId, {
        instrumentId: DYCA.id,
        side: 'SELL',
        type: 'MARKET',
        size: 1,
      });
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.rejectionReason, 'INSUFFICIENT_SHARES');
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 100_000, reserved: 0 });
    });

    it('LIMIT de compra por más de lo disponible', async () => {
      const userId = await createAccount(ctx.pool, 1_000);
      const { body } = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 101,
        price: 10,
      });
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.rejectionReason, 'INSUFFICIENT_FUNDS');
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 1_000, reserved: 0 });
    });

    it('los pesos reservados por una LIMIT no se pueden gastar en otra orden', async () => {
      const userId = await createAccount(ctx.pool, 1_000);
      const limit = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 18,
        price: 50, // reserva 900: quedan 100 libres
      });
      assert.equal(limit.body.status, 'NEW');

      const second = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'MARKET',
        size: 2, // 120 > 100
      });
      assert.equal(second.body.status, 'REJECTED');

      const third = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'MARKET',
        size: 1, // 60 <= 100
      });
      assert.equal(third.body.status, 'FILLED');
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 40, reserved: 900 });
    });

    it('las acciones reservadas por una LIMIT de venta no se pueden volver a vender', async () => {
      const userId = await createAccount(ctx.pool);
      await holdShares(ctx.app, ctx.pool, userId, POLL, 10);
      await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'LIMIT',
        size: 8,
        price: 70,
      });

      const oversell = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'MARKET',
        size: 3,
      });
      assert.equal(oversell.body.status, 'REJECTED');
      assert.equal(oversell.body.rejectionReason, 'INSUFFICIENT_SHARES');

      const allowed = await placeOrder(ctx.app, userId, {
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'MARKET',
        size: 2,
      });
      assert.equal(allowed.body.status, 'FILLED');
      assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), { available: 0, reserved: 8 });
    });
  });

  describe('sobre los datos del challenge', () => {
    it('el usuario 1 no puede vender BMA: su posición del seed está en −10', async () => {
      const { body } = await placeOrder(ctx.app, SEED.userWithHistory, {
        instrumentId: BMA.id,
        side: 'SELL',
        type: 'MARKET',
        size: 1,
      });
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.rejectionReason, 'INSUFFICIENT_SHARES');
    });

    it('el usuario 1 no puede gastar los pesos que sus LIMIT del seed tienen reservados', async () => {
      // Tiene $753.000 en total, pero $125.500 están en dos LIMIT en NEW: dispone de $627.500.
      const rejected = await placeOrder(ctx.app, SEED.userWithHistory, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 1,
        price: 627_500.01,
      });
      assert.equal(rejected.body.status, 'REJECTED');

      const accepted = await placeOrder(ctx.app, SEED.userWithHistory, {
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 1,
        price: 627_500,
      });
      assert.equal(accepted.body.status, 'NEW');
      assert.deepEqual(await cashOf(ctx.pool, SEED.userWithHistory), {
        available: 0,
        reserved: 753_000,
      });
    });
  });

  describe('pedidos inválidos: se informa el error y no se graba ninguna orden', () => {
    interface InvalidCase {
      name: string;
      body: Record<string, unknown>;
      status: number;
      code: string;
      userId?: number | string;
      key?: string | null;
    }

    const valid = { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', size: 1 };
    const limit = { instrumentId: POLL.id, side: 'BUY', type: 'LIMIT', size: 1, price: 50 };

    const cases: InvalidCase[] = [
      {
        name: 'sin Idempotency-Key',
        body: valid,
        key: null,
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'Idempotency-Key demasiado corta',
        body: valid,
        key: 'abc',
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'Idempotency-Key con caracteres raros',
        body: valid,
        key: 'key con espacios',
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'sin instrumentId',
        body: { side: 'BUY', type: 'MARKET', size: 1 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'sin side',
        body: { instrumentId: POLL.id, type: 'MARKET', size: 1 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'sin type',
        body: { instrumentId: POLL.id, side: 'BUY', size: 1 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'side desconocido',
        body: { ...valid, side: 'HOLD' },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'side CASH_IN (las transferencias no entran por acá)',
        body: { ...valid, side: 'CASH_IN' },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'side en minúscula',
        body: { ...valid, side: 'buy' },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'type desconocido',
        body: { ...valid, type: 'STOP' },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      { name: 'size en cero', body: { ...valid, size: 0 }, status: 400, code: 'VALIDATION_ERROR' },
      {
        name: 'size negativo',
        body: { ...valid, size: -5 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'size fraccionario',
        body: { ...valid, size: 1.5 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'size como texto',
        body: { ...valid, size: '10' },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'size booleano',
        body: { ...valid, size: true },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      { name: 'size null', body: { ...valid, size: null }, status: 400, code: 'VALIDATION_ERROR' },
      {
        name: 'size mayor al INT de Postgres',
        body: { ...valid, size: 2_147_483_648 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'amount en cero',
        body: { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', amount: 0 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'amount negativo',
        body: { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', amount: -100 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'amount como texto',
        body: { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', amount: '100' },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'amount con 3 decimales',
        body: { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', amount: 100.123 },
        status: 400,
        code: 'INVALID_MONEY_VALUE',
      },
      {
        name: 'size y amount juntos',
        body: { ...valid, amount: 100 },
        status: 400,
        code: 'SIZE_AND_AMOUNT_ARE_EXCLUSIVE',
      },
      {
        name: 'ni size ni amount',
        body: { instrumentId: POLL.id, side: 'BUY', type: 'MARKET' },
        status: 400,
        code: 'SIZE_OR_AMOUNT_REQUIRED',
      },
      {
        name: 'MARKET con price',
        body: { ...valid, price: 50 },
        status: 400,
        code: 'PRICE_NOT_ALLOWED',
      },
      {
        name: 'LIMIT sin price',
        body: { instrumentId: POLL.id, side: 'BUY', type: 'LIMIT', size: 1 },
        status: 400,
        code: 'PRICE_REQUIRED',
      },
      {
        name: 'price en cero',
        body: { ...limit, price: 0 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'price negativo',
        body: { ...limit, price: -1 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'price con 3 decimales',
        body: { ...limit, price: 50.555 },
        status: 400,
        code: 'INVALID_MONEY_VALUE',
      },
      {
        name: 'price mayor al que entra en la columna',
        body: { ...limit, price: 100_000_000 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'propiedad desconocida',
        body: { ...valid, prize: 10 },
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      {
        name: 'userId no numérico',
        body: valid,
        userId: 'abc',
        status: 400,
        code: 'VALIDATION_ERROR',
      },
      { name: 'userId en cero', body: valid, userId: 0, status: 400, code: 'VALIDATION_ERROR' },
      {
        name: 'usuario inexistente',
        body: valid,
        userId: 999_999,
        status: 404,
        code: 'USER_NOT_FOUND',
      },
      {
        name: 'instrumento inexistente',
        body: { ...valid, instrumentId: 999_999 },
        status: 404,
        code: 'INSTRUMENT_NOT_FOUND',
      },
      {
        name: 'operar ARS (es moneda, no un activo)',
        body: { ...valid, instrumentId: SEED.ARS },
        status: 422,
        code: 'INSTRUMENT_NOT_TRADABLE',
      },
      {
        name: 'MARKET sobre un instrumento sin precio',
        body: { ...valid, instrumentId: SEED.withoutPrice[1] },
        status: 422,
        code: 'MARKET_PRICE_UNAVAILABLE',
      },
      {
        name: 'monto que no alcanza para una acción',
        body: { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', amount: 59.99 },
        status: 422,
        code: 'AMOUNT_BELOW_UNIT_PRICE',
      },
      {
        name: 'monto LIMIT menor al precio límite',
        body: { instrumentId: POLL.id, side: 'BUY', type: 'LIMIT', amount: 49, price: 50 },
        status: 422,
        code: 'AMOUNT_BELOW_UNIT_PRICE',
      },
    ];

    let fundedUser: number;
    let ordersBefore: number;
    before(async () => {
      fundedUser = await createAccount(ctx.pool, 1_000_000);
      ordersBefore = await countOrders(ctx.pool);
    });

    for (const testCase of cases) {
      it(`${testCase.name} → ${testCase.status} ${testCase.code}`, async () => {
        const userId = (testCase.userId ?? fundedUser) as number;
        const response = await placeOrder<ErrorJson>(
          ctx.app,
          userId,
          testCase.body as OrderBody,
          testCase.key === undefined ? undefined : testCase.key,
        );
        assert.equal(response.status, testCase.status, JSON.stringify(response.body));
        assert.equal(response.body.error.code, testCase.code);
        assert.ok(response.body.error.message.length > 0);
        assert.ok(response.body.error.requestId.length > 0);
      });
    }

    it('JSON mal formado → 400', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/users/${fundedUser}/orders`,
        headers: { 'content-type': 'application/json', 'idempotency-key': 'malformed-json-1' },
        payload: '{"instrumentId": ',
      });
      assert.equal(response.statusCode, 400);
    });

    it('cuerpo desproporcionado → 413', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/users/${fundedUser}/orders`,
        headers: { 'content-type': 'application/json', 'idempotency-key': 'huge-body-0001' },
        payload: JSON.stringify({ ...valid, padding: 'x'.repeat(20_000) }),
      });
      assert.equal(response.statusCode, 413);
    });

    it('ninguno de esos pedidos grabó una orden ni tocó el saldo', async () => {
      assert.equal(await countOrders(ctx.pool), ordersBefore);
      assert.deepEqual(await cashOf(ctx.pool, fundedUser), { available: 1_000_000, reserved: 0 });
    });
  });
});
