import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  type Balance,
  balanceOf,
  cancelOrder,
  cashOf,
  createAccount,
  type ErrorJson,
  get,
  holdShares,
  placeOrder,
  SEED,
  tradesOf,
} from '../helpers/actions.ts';
import { createTestContext, type TestContext } from '../helpers/test-context.ts';

/**
 * Matriz completa del envío de órdenes. En vez de elegir casos a mano, se generan todas
 * las combinaciones de:
 *
 *   tipo (MARKET, LIMIT) × lado (BUY, SELL) × cómo se pide (cantidad, monto)
 *   × situación del saldo (sobra, justo, falta por una unidad, nada)
 *
 * Son 32 casos. Para cada uno, lo esperado se calcula acá con reglas escritas aparte de
 * la implementación, y se verifica la respuesta, la fila grabada, los saldos, el portfolio
 * y qué pasa al cancelar.
 */
const { POLL } = SEED;
const UNITS = 4;

const TYPES = ['MARKET', 'LIMIT'] as const;
const SIDES = ['BUY', 'SELL'] as const;
const QUANTITY_MODES = ['cantidad', 'monto'] as const;
const FUNDING = ['sobra', 'justo', 'falta', 'nada'] as const;

type OrderType = (typeof TYPES)[number];
type Side = (typeof SIDES)[number];
type Funding = (typeof FUNDING)[number];

/** Precio por unidad: el close para MARKET; un límite por debajo o por encima para LIMIT. */
function unitPrice(type: OrderType, side: Side): number {
  if (type === 'MARKET') return POLL.close;
  return side === 'BUY' ? 50 : 70;
}

/** Cuánto tiene la cuenta de lo que la orden necesita entregar. */
function fundedWith(funding: Funding, needed: number, surplus: number): number {
  switch (funding) {
    case 'sobra':
      return needed + surplus;
    case 'justo':
      return needed;
    case 'falta':
      return needed - 1;
    case 'nada':
      return 0;
  }
}

interface Expectation {
  status: 'FILLED' | 'NEW' | 'REJECTED';
  rejectionReason: string | null;
  cashBefore: Balance;
  sharesBefore: Balance;
  cashAfter: Balance;
  sharesAfter: Balance;
}

/** Reglas del enunciado, escritas de forma independiente de la implementación. */
function expectationFor(type: OrderType, side: Side, funding: Funding): Expectation {
  const price = unitPrice(type, side);
  const total = UNITS * price;
  const covered = funding === 'sobra' || funding === 'justo';

  const pesos = side === 'BUY' ? fundedWith(funding, total, 100) : 0;
  const shares = side === 'SELL' ? fundedWith(funding, UNITS, 3) : 0;
  const cashBefore = { available: pesos, reserved: 0 };
  const sharesBefore = { available: shares, reserved: 0 };

  if (!covered) {
    return {
      status: 'REJECTED',
      rejectionReason: side === 'BUY' ? 'INSUFFICIENT_FUNDS' : 'INSUFFICIENT_SHARES',
      cashBefore,
      sharesBefore,
      cashAfter: cashBefore,
      sharesAfter: sharesBefore,
    };
  }

  const executes = type === 'MARKET';
  const after =
    side === 'BUY'
      ? {
          cashAfter: { available: pesos - total, reserved: executes ? 0 : total },
          sharesAfter: { available: executes ? UNITS : 0, reserved: 0 },
        }
      : {
          cashAfter: { available: executes ? total : 0, reserved: 0 },
          sharesAfter: { available: shares - UNITS, reserved: executes ? 0 : UNITS },
        };
  return {
    status: executes ? 'FILLED' : 'NEW',
    rejectionReason: null,
    cashBefore,
    sharesBefore,
    ...after,
  };
}

interface PortfolioJson {
  availableCash: number;
  reservedCash: number;
  positions: Array<{ instrumentId: number; quantity: number; reservedQuantity: number }>;
}

describe('matriz de envío de órdenes: tipo × lado × cantidad/monto × saldo', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext();
  });
  after(() => ctx?.close({ verifyBalances: true }));

  async function accountWith(expected: Expectation): Promise<number> {
    const userId = await createAccount(ctx.pool, expected.cashBefore.available);
    if (expected.sharesBefore.available > 0) {
      await holdShares(ctx.app, ctx.pool, userId, POLL, expected.sharesBefore.available);
    }
    return userId;
  }

  for (const type of TYPES) {
    for (const side of SIDES) {
      for (const mode of QUANTITY_MODES) {
        for (const funding of FUNDING) {
          const expected = expectationFor(type, side, funding);
          const price = unitPrice(type, side);
          const total = UNITS * price;
          // Por monto se pide lo que valen 4 unidades y media: tienen que operarse 4.
          const quantity = mode === 'cantidad' ? { size: UNITS } : { amount: total + price / 2 };
          const body = {
            instrumentId: POLL.id,
            side,
            type,
            ...quantity,
            ...(type === 'LIMIT' ? { price } : {}),
          };

          it(`${type} ${side} por ${mode}, saldo: ${funding} → ${expected.status}`, async () => {
            const userId = await accountWith(expected);
            const ordersBefore = (await tradesOf(ctx.pool, userId)).length;

            const { status, body: order } = await placeOrder(ctx.app, userId, body);

            // Respuesta
            assert.equal(status, 201);
            assert.equal(order.status, expected.status);
            assert.equal(order.rejectionReason, expected.rejectionReason);
            assert.equal(order.size, UNITS);
            assert.equal(order.price, price);
            assert.equal(order.total, total);
            assert.equal(order.side, side);
            assert.equal(order.type, type);

            // Fila grabada
            const stored = (await tradesOf(ctx.pool, userId)).at(-1);
            assert.equal((await tradesOf(ctx.pool, userId)).length, ordersBefore + 1);
            assert.equal(stored?.id, order.id);
            assert.equal(stored?.status, expected.status);
            assert.equal(stored?.size, UNITS);
            assert.equal(Number(stored?.price), price);
            assert.equal(stored?.rejection_reason, expected.rejectionReason);

            // Saldos
            assert.deepEqual(await cashOf(ctx.pool, userId), expected.cashAfter);
            assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), expected.sharesAfter);

            // Portfolio (calculado desde orders): tiene que decir lo mismo
            const portfolio = (await get<PortfolioJson>(ctx.app, `/users/${userId}/portfolio`))
              .body;
            const held = expected.sharesAfter.available + expected.sharesAfter.reserved;
            assert.equal(portfolio.availableCash, expected.cashAfter.available);
            assert.equal(portfolio.reservedCash, expected.cashAfter.reserved);
            assert.deepEqual(
              portfolio.positions.map((p) => [p.instrumentId, p.quantity, p.reservedQuantity]),
              held > 0 ? [[POLL.id, held, expected.sharesAfter.reserved]] : [],
            );

            // Cancelar: solo una orden NEW se cancela, y deja todo como antes de enviarla
            const cancelled = await cancelOrder<ErrorJson & { status?: string }>(
              ctx.app,
              userId,
              order.id,
            );
            if (expected.status === 'NEW') {
              assert.equal(cancelled.status, 200);
              assert.equal(cancelled.body.status, 'CANCELLED');
              assert.deepEqual(await cashOf(ctx.pool, userId), expected.cashBefore);
              assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), expected.sharesBefore);
            } else {
              assert.equal(cancelled.status, 409);
              assert.equal(cancelled.body.error.code, 'ORDER_NOT_CANCELLABLE');
              assert.deepEqual(await cashOf(ctx.pool, userId), expected.cashAfter);
              assert.deepEqual(await balanceOf(ctx.pool, userId, POLL.id), expected.sharesAfter);
            }
          });
        }
      }
    }
  }
});
