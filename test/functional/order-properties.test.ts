import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import fc from 'fast-check';
import { findBalanceMismatches } from '../../src/modules/orders/balance-reconciliation.repository.ts';
import {
  balanceOf,
  cancelOrder,
  cashOf,
  createAccount,
  type ErrorJson,
  fund,
  get,
  holdShares,
  type OrderBody,
  type OrderJson,
  placeOrder,
  SEED,
  tradesOf,
} from '../helpers/actions.ts';
import { createTestContext, type TestContext } from '../helpers/test-context.ts';

/**
 * Tests basados en propiedades contra la API completa y Postgres real.
 *
 * fast-check genera cuentas y secuencias de operaciones al azar (comprar, vender, MARKET,
 * LIMIT, por cantidad, por monto, cancelar, reintentar). Un modelo de referencia mínimo,
 * escrito acá sin usar nada de la implementación, predice qué tiene que pasar; después de
 * cada paso se compara la respuesta de la API con la del modelo.
 *
 * Si una secuencia falla, fast-check la reduce a la más corta que reproduce el problema e
 * imprime la semilla para repetirla.
 */
const INSTRUMENTS = [SEED.POLL, SEED.DYCA, SEED.DOME] as const;
type Instrument = (typeof INSTRUMENTS)[number];

const toCents = (pesos: number): number => Math.round(pesos * 100);

// ── Operaciones generadas ────────────────────────────────────────────────────

interface PlaceOp {
  kind: 'place';
  instrument: Instrument;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: { size: number } | { amount: number };
  limitPrice: number;
}

interface CancelOp {
  kind: 'cancel';
  /** Elige una de las órdenes ya enviadas (módulo la cantidad que haya). */
  pick: number;
}

interface ReplayOp {
  kind: 'replay';
  pick: number;
}

type Operation = PlaceOp | CancelOp | ReplayOp;

const pesosWithCents = (min: number, max: number) =>
  fc.integer({ min: min * 100, max: max * 100 }).map((hundredths) => hundredths / 100);

const placeArb: fc.Arbitrary<PlaceOp> = fc.record({
  kind: fc.constant('place' as const),
  instrument: fc.constantFrom(...INSTRUMENTS),
  side: fc.constantFrom('BUY' as const, 'SELL' as const),
  type: fc.constantFrom('MARKET' as const, 'LIMIT' as const),
  quantity: fc.oneof(
    fc.record({ size: fc.integer({ min: 1, max: 12 }) }),
    fc.record({ amount: pesosWithCents(1, 3000) }),
  ),
  limitPrice: pesosWithCents(1, 400),
});

const cancelArb: fc.Arbitrary<CancelOp> = fc.record({
  kind: fc.constant('cancel' as const),
  pick: fc.nat(),
});

const replayArb: fc.Arbitrary<ReplayOp> = fc.record({
  kind: fc.constant('replay' as const),
  pick: fc.nat(),
});

const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 6, arbitrary: placeArb },
  { weight: 2, arbitrary: cancelArb },
  { weight: 1, arbitrary: replayArb },
);

function bodyOf(op: PlaceOp): OrderBody {
  return {
    instrumentId: op.instrument.id,
    side: op.side,
    type: op.type,
    ...op.quantity,
    ...(op.type === 'LIMIT' ? { price: op.limitPrice } : {}),
  };
}

// ── Modelo de referencia ─────────────────────────────────────────────────────

interface ModelBalance {
  available: number;
  reserved: number;
}

type PlaceExpectation =
  | { outcome: 'TOO_SMALL' }
  | {
      outcome: 'ORDER';
      status: 'FILLED' | 'NEW' | 'REJECTED';
      reason: string | null;
      size: number;
      priceCents: number;
      totalCents: number;
    };

interface ModelOrder {
  id: number;
  key: string;
  body: OrderBody;
  instrumentId: number;
  side: 'BUY' | 'SELL';
  status: string;
  size: number;
  totalCents: number;
}

/** Las reglas del enunciado en su forma más simple: una cuenta, en memoria, de a un paso. */
class AccountModel {
  readonly cash: ModelBalance;
  readonly orders: ModelOrder[] = [];
  private readonly shares = new Map<number, ModelBalance>();

  constructor(fundsInPesos: number) {
    this.cash = { available: toCents(fundsInPesos), reserved: 0 };
  }

  position(instrumentId: number): ModelBalance {
    let position = this.shares.get(instrumentId);
    if (!position) {
      position = { available: 0, reserved: 0 };
      this.shares.set(instrumentId, position);
    }
    return position;
  }

  place(op: PlaceOp): PlaceExpectation {
    const priceCents = toCents(op.type === 'MARKET' ? op.instrument.close : op.limitPrice);
    const size =
      'size' in op.quantity
        ? op.quantity.size
        : Math.floor(toCents(op.quantity.amount) / priceCents);
    if (size === 0) return { outcome: 'TOO_SMALL' };

    const totalCents = size * priceCents;
    const position = this.position(op.instrument.id);
    const executes = op.type === 'MARKET';
    const order = { outcome: 'ORDER' as const, size, priceCents, totalCents };

    if (op.side === 'BUY') {
      if (this.cash.available < totalCents) {
        return { ...order, status: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' };
      }
      this.cash.available -= totalCents;
      if (executes) position.available += size;
      else this.cash.reserved += totalCents;
    } else {
      if (position.available < size) {
        return { ...order, status: 'REJECTED', reason: 'INSUFFICIENT_SHARES' };
      }
      position.available -= size;
      if (executes) this.cash.available += totalCents;
      else position.reserved += size;
    }
    return { ...order, status: executes ? 'FILLED' : 'NEW', reason: null };
  }

  /** Devuelve el status HTTP esperado al cancelar. */
  cancel(order: ModelOrder): 200 | 409 {
    if (order.status === 'CANCELLED') return 200;
    if (order.status !== 'NEW') return 409;

    if (order.side === 'BUY') {
      this.cash.reserved -= order.totalCents;
      this.cash.available += order.totalCents;
    } else {
      const position = this.position(order.instrumentId);
      position.reserved -= order.size;
      position.available += order.size;
    }
    order.status = 'CANCELLED';
    return 200;
  }

  pick(index: number): ModelOrder | undefined {
    return this.orders.length === 0 ? undefined : this.orders[index % this.orders.length];
  }

  totalValueCents(): number {
    const positions = INSTRUMENTS.reduce((sum, instrument) => {
      const position = this.position(instrument.id);
      return sum + (position.available + position.reserved) * toCents(instrument.close);
    }, 0);
    return this.cash.available + this.cash.reserved + positions;
  }
}

interface PortfolioJson {
  totalAccountValue: number;
  availableCash: number;
  reservedCash: number;
  positions: Array<{ instrumentId: number; quantity: number; reservedQuantity: number }>;
}

describe('propiedades de la API de órdenes', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext();
  });
  after(() => ctx?.close({ verifyBalances: true }));

  const mismatchesOf = async (userId: number) =>
    (await findBalanceMismatches(ctx.pool)).filter((mismatch) => mismatch.userId === userId);

  async function assertMatchesModel(userId: number, model: AccountModel): Promise<void> {
    assert.deepEqual(await cashOf(ctx.pool, userId), {
      available: model.cash.available / 100,
      reserved: model.cash.reserved / 100,
    });
    for (const instrument of INSTRUMENTS) {
      assert.deepEqual(
        await balanceOf(ctx.pool, userId, instrument.id),
        model.position(instrument.id),
        `saldo de ${instrument.id}`,
      );
    }

    // El portfolio se calcula por otro camino (desde orders): tiene que coincidir igual.
    const portfolio = (await get<PortfolioJson>(ctx.app, `/users/${userId}/portfolio`)).body;
    assert.equal(portfolio.availableCash, model.cash.available / 100);
    assert.equal(portfolio.reservedCash, model.cash.reserved / 100);
    assert.equal(portfolio.totalAccountValue, model.totalValueCents() / 100);
    const held = INSTRUMENTS.map((instrument) => ({
      instrumentId: instrument.id,
      quantity: model.position(instrument.id).available + model.position(instrument.id).reserved,
      reservedQuantity: model.position(instrument.id).reserved,
    })).filter((position) => position.quantity > 0);
    assert.deepEqual(
      portfolio.positions
        .map((p) => ({
          instrumentId: p.instrumentId,
          quantity: p.quantity,
          reservedQuantity: p.reservedQuantity,
        }))
        .sort((a, b) => a.instrumentId - b.instrumentId),
      held.sort((a, b) => a.instrumentId - b.instrumentId),
    );

    assert.deepEqual(await mismatchesOf(userId), []);
  }

  async function applyPlace(userId: number, model: AccountModel, op: PlaceOp): Promise<void> {
    const key = randomUUID();
    const body = bodyOf(op);
    const expected = model.place(op);
    const response = await placeOrder<OrderJson & ErrorJson>(ctx.app, userId, body, key);

    if (expected.outcome === 'TOO_SMALL') {
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'AMOUNT_BELOW_UNIT_PRICE');
      return;
    }
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.status, expected.status);
    assert.equal(response.body.rejectionReason, expected.reason);
    assert.equal(response.body.size, expected.size);
    assert.equal(response.body.price, expected.priceCents / 100);
    assert.equal(response.body.total, expected.totalCents / 100);

    model.orders.push({
      id: response.body.id,
      key,
      body,
      instrumentId: op.instrument.id,
      side: op.side,
      status: expected.status,
      size: expected.size,
      totalCents: expected.totalCents,
    });
  }

  async function applyCancel(userId: number, model: AccountModel, op: CancelOp): Promise<void> {
    const target = model.pick(op.pick);
    if (!target) return;
    const expectedStatus = model.cancel(target);
    const response = await cancelOrder<OrderJson & ErrorJson>(ctx.app, userId, target.id);

    assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
    if (expectedStatus === 200) assert.equal(response.body.status, 'CANCELLED');
    else assert.equal(response.body.error.code, 'ORDER_NOT_CANCELLABLE');
  }

  /** Reenviar un pedido anterior con su misma key: devuelve esa orden y no cambia nada. */
  async function applyReplay(userId: number, model: AccountModel, op: ReplayOp): Promise<void> {
    const target = model.pick(op.pick);
    if (!target) return;
    const response = await placeOrder(ctx.app, userId, target.body, target.key);

    assert.equal(response.status, 200);
    assert.equal(response.headers['idempotent-replayed'], 'true');
    assert.equal(response.body.id, target.id);
    assert.equal(response.body.status, target.status);
  }

  it('cualquier secuencia de operaciones deja la cuenta como dice el modelo', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5000 }),
        fc.array(operationArb, { minLength: 1, maxLength: 25 }),
        async (funds, operations) => {
          const userId = await createAccount(ctx.pool, funds);
          const model = new AccountModel(funds);

          for (const op of operations) {
            if (op.kind === 'place') await applyPlace(userId, model, op);
            else if (op.kind === 'cancel') await applyCancel(userId, model, op);
            else await applyReplay(userId, model, op);
          }

          await assertMatchesModel(userId, model);
          assert.equal((await tradesOf(ctx.pool, userId)).length, model.orders.length);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('cancelar todas las órdenes pendientes devuelve cada reserva: no queda nada apartado', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5000 }),
        fc.array(placeArb, { minLength: 1, maxLength: 20 }),
        async (funds, operations) => {
          const userId = await createAccount(ctx.pool, funds);
          const model = new AccountModel(funds);
          for (const op of operations) await applyPlace(userId, model, op);

          for (const order of model.orders) {
            const response = await cancelOrder(ctx.app, userId, order.id);
            assert.equal(response.status, model.cancel(order));
          }

          assert.equal((await cashOf(ctx.pool, userId)).reserved, 0);
          for (const instrument of INSTRUMENTS) {
            assert.equal((await balanceOf(ctx.pool, userId, instrument.id)).reserved, 0);
          }
          await assertMatchesModel(userId, model);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('comprar y vender a mercado nunca crea ni destruye valor: el total de la cuenta no cambia', async () => {
    const marketOnly = placeArb.map((op) => ({ ...op, type: 'MARKET' as const }));
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 5000 }),
        fc.array(marketOnly, { minLength: 1, maxLength: 20 }),
        async (funds, operations) => {
          const userId = await createAccount(ctx.pool, funds);
          for (const op of operations) await placeOrder(ctx.app, userId, bodyOf(op));

          const portfolio = (await get<PortfolioJson>(ctx.app, `/users/${userId}/portfolio`)).body;
          // Todo se opera al último close, que es el mismo precio al que se valúa.
          assert.equal(portfolio.totalAccountValue, funds);
          assert.ok(portfolio.availableCash >= 0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('operaciones simultáneas al azar: nunca hay saldos negativos y la contabilidad cierra', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 0, max: 20 }),
        fc.array(placeArb, { minLength: 5, maxLength: 30 }),
        async (funds, initialShares, operations) => {
          const userId = await createAccount(ctx.pool);
          if (initialShares > 0) {
            await holdShares(ctx.app, ctx.pool, userId, SEED.POLL, initialShares);
          }
          if (funds > 0) await fund(ctx.pool, userId, funds);

          // Todas a la vez: compiten por las mismas filas de saldo.
          const responses = await Promise.all(
            operations.map(async (op) => ({
              op,
              response: await placeOrder<OrderJson & ErrorJson>(ctx.app, userId, bodyOf(op)),
            })),
          );

          const orders = responses.flatMap(({ op, response }) => {
            if (response.status === 422) {
              assert.equal(response.body.error.code, 'AMOUNT_BELOW_UNIT_PRICE');
              return [];
            }
            assert.equal(response.status, 201, JSON.stringify(response.body));
            return [{ op, order: response.body }];
          });
          const sumOf = (
            status: string,
            side: string,
            value: (o: OrderJson) => number,
            instrumentId?: number,
          ) =>
            orders
              .filter(
                ({ order }) =>
                  order.status === status &&
                  order.side === side &&
                  (instrumentId === undefined || order.instrumentId === instrumentId),
              )
              .reduce((sum, { order }) => sum + value(order), 0);
          const cents = (order: OrderJson) => toCents(order.total);
          const size = (order: OrderJson) => order.size;

          // Pesos: nada negativo, lo reservado es lo de las LIMIT de compra pendientes, y
          // el total es lo inicial menos lo comprado más lo vendido.
          const cash = await cashOf(ctx.pool, userId);
          assert.ok(cash.available >= 0, `pesos disponibles negativos: ${cash.available}`);
          assert.equal(toCents(cash.reserved), sumOf('NEW', 'BUY', cents));
          assert.equal(
            toCents(cash.available) + toCents(cash.reserved),
            toCents(funds) - sumOf('FILLED', 'BUY', cents) + sumOf('FILLED', 'SELL', cents),
          );

          // Acciones: lo mismo, por instrumento.
          for (const instrument of INSTRUMENTS) {
            const position = await balanceOf(ctx.pool, userId, instrument.id);
            const initial = instrument.id === SEED.POLL.id ? initialShares : 0;
            assert.ok(position.available >= 0, `acciones negativas de ${instrument.id}`);
            assert.equal(position.reserved, sumOf('NEW', 'SELL', size, instrument.id));
            assert.equal(
              position.available + position.reserved,
              initial +
                sumOf('FILLED', 'BUY', size, instrument.id) -
                sumOf('FILLED', 'SELL', size, instrument.id),
            );
          }

          assert.deepEqual(await mismatchesOf(userId), []);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('el mismo pedido enviado varias veces a la vez con la misma key crea una sola orden', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5000 }),
        placeArb,
        fc.integer({ min: 2, max: 6 }),
        async (funds, op, copies) => {
          const userId = await createAccount(ctx.pool, funds);
          const model = new AccountModel(funds);
          const expected = model.place(op); // el modelo lo aplica una sola vez
          const key = randomUUID();

          const responses = await Promise.all(
            Array.from({ length: copies }, () =>
              placeOrder<OrderJson & ErrorJson>(ctx.app, userId, bodyOf(op), key),
            ),
          );

          if (expected.outcome === 'TOO_SMALL') {
            assert.ok(responses.every((response) => response.status === 422));
            assert.equal((await tradesOf(ctx.pool, userId)).length, 0);
            return;
          }
          assert.equal(responses.filter((response) => response.status === 201).length, 1);
          assert.equal(responses.filter((response) => response.status === 200).length, copies - 1);
          assert.equal(new Set(responses.map((response) => response.body.id)).size, 1);
          assert.ok(responses.every((response) => response.body.status === expected.status));
          assert.equal((await tradesOf(ctx.pool, userId)).length, 1);
          await assertMatchesModel(userId, model);
        },
      ),
      { numRuns: 25 },
    );
  });
});
