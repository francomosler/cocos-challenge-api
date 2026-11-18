import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  cashOf,
  countOrders,
  createAccount,
  type ErrorJson,
  type OrderJson,
  placeOrder,
  SEED,
  tradesOf,
} from '../helpers/actions.ts';
import { createTestContext, type TestContext } from '../helpers/test-context.ts';

/** Valores en el límite de lo que el esquema y las columnas admiten. */
const { POLL, DOME, PAMP } = SEED;
const MAX_INT = 2_147_483_647;
const MAX_PRICE = 99_999_999.99;

describe('envío de órdenes: valores límite', () => {
  let ctx: TestContext;
  let userId: number;
  before(async () => {
    ctx = await createTestContext();
    userId = await createAccount(ctx.pool, 10_000);
  });
  after(() => ctx?.close({ verifyBalances: true }));

  const place = (body: Record<string, unknown>, key: string | null = randomUUID()) =>
    placeOrder<OrderJson & ErrorJson>(ctx.app, userId, body as never, key);

  describe('órdenes enormes', () => {
    it('la compra más grande posible no desborda: queda REJECTED por saldo', async () => {
      const { status, body } = await place({
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        size: MAX_INT,
        price: MAX_PRICE,
      });

      assert.equal(status, 201);
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.rejectionReason, 'INSUFFICIENT_FUNDS');
      assert.equal(body.size, MAX_INT);
      assert.equal(body.price, MAX_PRICE);

      // En la base el importe queda exacto: 2.147.483.647 × 99.999.999,99.
      const { rows } = await ctx.pool.query<{ total: string }>(
        'SELECT (size * price)::text AS total FROM orders WHERE id = $1',
        [body.id],
      );
      assert.equal(rows[0]?.total, '214748364678525163.53');
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 10_000, reserved: 0 });
    });

    it('la venta más grande posible queda REJECTED por falta de acciones', async () => {
      const { status, body } = await place({
        instrumentId: POLL.id,
        side: 'SELL',
        type: 'MARKET',
        size: MAX_INT,
      });
      assert.equal(status, 201);
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.rejectionReason, 'INSUFFICIENT_SHARES');
    });

    it('un monto que equivale a más acciones de las que entran en la columna → 400', async () => {
      const { status, body } = await place({
        instrumentId: DOME.id, // $20,50: un billón de pesos son 48.780 millones de acciones
        side: 'BUY',
        type: 'MARKET',
        amount: 1_000_000_000_000,
      });
      assert.equal(status, 400);
      assert.equal(body.error.code, 'SIZE_OUT_OF_RANGE');
    });

    it('el monto máximo, cuando la cantidad sí entra, se evalúa normalmente', async () => {
      const { status, body } = await place({
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        amount: 1_000_000_000_000,
        price: 1_000,
      });
      assert.equal(status, 201);
      assert.equal(body.size, 1_000_000_000);
      assert.equal(body.status, 'REJECTED');
    });

    it('un monto mayor al máximo → 400', async () => {
      const { status } = await place({
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'MARKET',
        amount: 1_000_000_000_000.01,
      });
      assert.equal(status, 400);
    });
  });

  describe('precios en el borde', () => {
    it('acepta el precio mínimo: un centavo', async () => {
      const { status, body } = await place({
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 3,
        price: 0.01,
      });
      assert.equal(status, 201);
      assert.equal(body.status, 'NEW');
      assert.equal(body.total, 0.03);
      assert.deepEqual(await cashOf(ctx.pool, userId), { available: 9999.97, reserved: 0.03 });
    });

    it('acepta el precio máximo de la columna', async () => {
      const { status, body } = await place({
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        size: 1,
        price: MAX_PRICE,
      });
      assert.equal(status, 201);
      assert.equal(body.price, MAX_PRICE);
      assert.equal(body.status, 'REJECTED');
    });

    for (const price of [0.001, 1e-7, 0.009]) {
      it(`un precio de ${price} (menos de un centavo) → 400`, async () => {
        const { status, body } = await place({
          instrumentId: POLL.id,
          side: 'BUY',
          type: 'LIMIT',
          size: 1,
          price,
        });
        assert.equal(status, 400);
        assert.equal(body.error.code, 'INVALID_MONEY_VALUE');
      });
    }

    it('a un centavo por acción, un monto chico ya compra miles', async () => {
      const { body } = await place({
        instrumentId: POLL.id,
        side: 'BUY',
        type: 'LIMIT',
        amount: 50,
        price: 0.01,
      });
      assert.equal(body.size, 5_000);
      assert.equal(body.status, 'NEW');
    });
  });

  describe('formas válidas de escribir un número en JSON', () => {
    const send = (rawBody: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/users/${userId}/orders`,
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        payload: rawBody,
      });

    it('"size": 2.0 es el entero 2', async () => {
      const response = await send(
        `{"instrumentId":${POLL.id},"side":"BUY","type":"MARKET","size":2.0}`,
      );
      assert.equal(response.statusCode, 201);
      assert.equal(response.json().size, 2);
    });

    it('"size": 1e1 es el entero 10', async () => {
      const response = await send(
        `{"instrumentId":${POLL.id},"side":"BUY","type":"MARKET","size":1e1}`,
      );
      assert.equal(response.statusCode, 201);
      assert.equal(response.json().size, 10);
    });

    it('"amount": 120.50 y "amount": 120.5 son el mismo importe', async () => {
      const response = await send(
        `{"instrumentId":${POLL.id},"side":"BUY","type":"MARKET","amount":120.50}`,
      );
      assert.equal(response.statusCode, 201);
      assert.equal(response.json().size, 2);
    });

    it('"amount": -0 no es un monto', async () => {
      const response = await send(
        `{"instrumentId":${POLL.id},"side":"BUY","type":"MARKET","amount":-0}`,
      );
      assert.equal(response.statusCode, 400);
    });

    for (const [name, rawBody] of [
      ['un arreglo', '[]'],
      ['null', 'null'],
      ['un texto', '"comprar"'],
      ['un número', '42'],
      ['un objeto vacío', '{}'],
    ] as const) {
      it(`el cuerpo es ${name} → 400`, async () => {
        const response = await send(rawBody);
        assert.equal(response.statusCode, 400);
        assert.equal(response.json().error.code, 'VALIDATION_ERROR');
      });
    }

    for (const contentType of [
      'text/plain',
      'application/xml',
      'application/x-www-form-urlencoded',
    ]) {
      it(`un cuerpo ${contentType} → 415: la API solo acepta JSON`, async () => {
        const response = await ctx.app.inject({
          method: 'POST',
          url: `/users/${userId}/orders`,
          headers: { 'content-type': contentType, 'idempotency-key': randomUUID() },
          payload: 'instrumentId=53&side=BUY&type=MARKET&size=1',
        });
        assert.equal(response.statusCode, 415);
        assert.equal(response.json().error.code, 'FST_ERR_CTP_INVALID_MEDIA_TYPE');
      });
    }
  });

  describe('Idempotency-Key en el borde', () => {
    const valid = { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', size: 1 };

    for (const [length, expected] of [
      [7, 400],
      [8, 201],
      [64, 201],
      [65, 400],
    ] as const) {
      it(`una key de ${length} caracteres → ${expected}`, async () => {
        const { status } = await place(valid, 'k'.repeat(length));
        assert.equal(status, expected);
      });
    }

    it('acepta un UUID, y también otros formatos usuales de identificador', async () => {
      for (const key of [randomUUID(), 'orden:2026-11-17:0001', 'a.b_c-d.0123456789']) {
        assert.equal((await place(valid, key)).status, 201, key);
      }
    });

    it('la key distingue mayúsculas de minúsculas: son dos intenciones', async () => {
      const first = await place(valid, 'Clave-Unica-0001');
      const second = await place(valid, 'clave-unica-0001');
      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.notEqual(first.body.id, second.body.id);
    });
  });

  describe('identificadores en el borde', () => {
    const valid = { instrumentId: POLL.id, side: 'BUY', type: 'MARKET', size: 1 };

    it('el userId más grande que entra en la columna no existe: 404, no un error interno', async () => {
      const response = await placeOrder<ErrorJson>(ctx.app, MAX_INT, valid);
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, 'USER_NOT_FOUND');
    });

    it('un userId que ya no entra en la columna → 400', async () => {
      const response = await placeOrder<ErrorJson>(ctx.app, MAX_INT + 1, valid);
      assert.equal(response.status, 400);
    });

    it('el instrumentId más grande que entra en la columna no existe: 404', async () => {
      const { status, body } = await place({ ...valid, instrumentId: MAX_INT });
      assert.equal(status, 404);
      assert.equal(body.error.code, 'INSTRUMENT_NOT_FOUND');
    });

    it('GET sobre la ruta de órdenes no existe: no hay endpoints de consulta', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/users/${userId}/orders` });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, 'ROUTE_NOT_FOUND');
    });
  });

  describe('precisión', () => {
    it('muchas compras con centavos no acumulan error de redondeo', async () => {
      const account = await createAccount(ctx.pool, 100_000);
      const before = await countOrders(ctx.pool);

      // 30 compras de 3 PAMP a $925,85: en coma flotante 2777,55 × 30 no da exacto.
      for (let index = 0; index < 30; index++) {
        const { body } = await placeOrder(ctx.app, account, {
          instrumentId: PAMP.id,
          side: 'BUY',
          type: 'MARKET',
          size: 3,
        });
        assert.equal(body.total, 2777.55);
      }

      assert.equal((await countOrders(ctx.pool)) - before, 30);
      assert.deepEqual(await cashOf(ctx.pool, account), { available: 16_673.5, reserved: 0 });
      assert.equal((await tradesOf(ctx.pool, account)).length, 30);
    });
  });
});
