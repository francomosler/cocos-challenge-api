import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { escapeLikePattern } from '../../src/modules/instruments/instrument.repository.ts';
import {
  AmountBelowUnitPriceError,
  InvalidOrderError,
} from '../../src/modules/orders/domain/order-errors.ts';
import { legsFor } from '../../src/modules/orders/domain/order-legs.ts';
import {
  MAX_ORDER_SIZE,
  quantityFrom,
  resolveSize,
} from '../../src/modules/orders/domain/order-sizing.ts';
import { hashOrderRequest, type PlaceOrderCommand } from '../../src/modules/orders/place-order.ts';
import {
  foldTrades,
  type Trade,
  valuePosition,
} from '../../src/modules/portfolio/domain/portfolio-calculator.ts';
import {
  formatCents,
  InvalidMoneyError,
  parseCents,
  parseSignedCents,
  percentChange,
  totalFor,
} from '../../src/shared/money.ts';

/**
 * Tests basados en propiedades: en vez de ejemplos elegidos a mano, fast-check genera
 * cientos de entradas al azar y verifica que una regla se cumpla para todas. Si alguna
 * falla, reduce el caso al más chico que la rompe y muestra la semilla para repetirlo.
 */
const cents = (max: bigint) => fc.bigInt({ min: 0n, max });
const positiveCents = (max: bigint) => fc.bigInt({ min: 1n, max });

describe('propiedades del dinero', () => {
  it('formatear y volver a leer devuelve el mismo importe', () => {
    fc.assert(
      fc.property(cents(10n ** 18n), (amount) => {
        assert.equal(parseCents(formatCents(amount)), amount);
      }),
    );
  });

  it('lo mismo con importes negativos', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), (amount) => {
        assert.equal(parseSignedCents(formatCents(amount)), amount);
      }),
    );
  });

  it('todo número JSON con hasta 2 decimales se lee exacto, sin error de coma flotante', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 ** 13 }), (hundredths) => {
        assert.equal(parseCents(hundredths / 100), BigInt(hundredths));
      }),
    );
  });

  it('un importe con un tercer decimal significativo se rechaza, nunca se redondea', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 10 ** 9 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 1, max: 9 }),
        (whole, hundredths, thousandth) => {
          const text = `${whole}.${String(hundredths).padStart(2, '0')}${thousandth}`;
          assert.throws(() => parseCents(text), InvalidMoneyError);
        },
      ),
    );
  });

  it('el total es proporcional a la cantidad', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: MAX_ORDER_SIZE }),
        fc.nat({ max: MAX_ORDER_SIZE }),
        positiveCents(9_999_999_999n),
        (a, b, price) => {
          assert.equal(
            totalFor(a, price) + totalFor(b, price),
            totalFor(BigInt(a) + BigInt(b), price),
          );
        },
      ),
    );
  });

  it('la variación porcentual crece con el valor final y es cero si no cambió', () => {
    fc.assert(
      fc.property(positiveCents(10n ** 12n), cents(10n ** 12n), cents(10n ** 12n), (from, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        const lower = percentChange(from, low) as number;
        const higher = percentChange(from, high) as number;
        assert.ok(lower <= higher);
        assert.equal(percentChange(from, from), 0);
        if (high >= from) assert.ok(higher >= 0);
        if (high <= from) assert.ok(higher <= 0);
      }),
    );
  });
});

describe('propiedades del tamaño de la orden', () => {
  it('por monto: compra todas las acciones que el monto paga, y ni una más', () => {
    fc.assert(
      fc.property(positiveCents(10n ** 9n), positiveCents(10n ** 13n), (price, amount) => {
        const units = amount / price;
        const quantity = { kind: 'AMOUNT', amount } as const;

        if (units === 0n) {
          assert.throws(() => resolveSize(quantity, price), AmountBelowUnitPriceError);
        } else if (units > BigInt(MAX_ORDER_SIZE)) {
          assert.throws(() => resolveSize(quantity, price), InvalidOrderError);
        } else {
          const size = BigInt(resolveSize(quantity, price));
          assert.ok(size * price <= amount, 'no gasta más que el monto');
          assert.ok((size + 1n) * price > amount, 'una acción más ya no entraba');
        }
      }),
    );
  });

  it('por cantidad: el precio nunca cambia el tamaño', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_ORDER_SIZE }),
        positiveCents(9_999_999_999n),
        (size, price) => {
          assert.equal(resolveSize({ kind: 'SIZE', size }, price), size);
        },
      ),
    );
  });

  it('se acepta exactamente una forma de pedir: cantidad o monto', () => {
    const optionalSize = fc.option(fc.integer({ min: 1, max: MAX_ORDER_SIZE }), { nil: undefined });
    const optionalAmount = fc.option(positiveCents(10n ** 13n), { nil: undefined });

    fc.assert(
      fc.property(optionalSize, optionalAmount, (size, amount) => {
        const input = {
          ...(size !== undefined ? { size } : {}),
          ...(amount !== undefined ? { amount } : {}),
        };
        const exactlyOne = (size !== undefined) !== (amount !== undefined);
        if (exactlyOne) {
          assert.equal(quantityFrom(input).kind, size !== undefined ? 'SIZE' : 'AMOUNT');
        } else {
          assert.throws(() => quantityFrom(input), InvalidOrderError);
        }
      }),
    );
  });
});

describe('propiedades de las patas de la orden', () => {
  it('una compra y una venta de lo mismo son espejo: lo que una entrega, la otra lo recibe', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65 }),
        fc.integer({ min: 1, max: MAX_ORDER_SIZE }),
        positiveCents(9_999_999_999n),
        (instrumentId, size, price) => {
          const terms = { instrumentId, size, price };
          const buy = legsFor({ ...terms, side: 'BUY' }, 66);
          const sell = legsFor({ ...terms, side: 'SELL' }, 66);

          assert.deepEqual(buy.debit, sell.credit);
          assert.deepEqual(buy.credit, sell.debit);
          assert.equal(parseCents(buy.debit.amount), BigInt(size) * price);
          assert.equal(buy.credit.amount, String(size));
        },
      ),
    );
  });
});

describe('propiedades de la huella del pedido', () => {
  const commandArb: fc.Arbitrary<PlaceOrderCommand> = fc
    .record({
      userId: fc.integer({ min: 1, max: 9 }),
      idempotencyKey: fc.constantFrom('key-a', 'key-b'),
      instrumentId: fc.integer({ min: 1, max: 3 }),
      side: fc.constantFrom('BUY', 'SELL'),
      type: fc.constantFrom('MARKET', 'LIMIT'),
      size: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
      amount: fc.option(fc.bigInt({ min: 1n, max: 3n }), { nil: undefined }),
      price: fc.option(fc.bigInt({ min: 1n, max: 3n }), { nil: undefined }),
    })
    .map((fields) => {
      // Las propiedades ausentes se omiten, igual que hace el mapeo desde HTTP.
      const { size, amount, price, ...rest } = fields;
      return {
        ...rest,
        ...(size !== undefined ? { size } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(price !== undefined ? { price } : {}),
      } as PlaceOrderCommand;
    });

  const sameRequest = (a: PlaceOrderCommand, b: PlaceOrderCommand) =>
    a.instrumentId === b.instrumentId &&
    a.side === b.side &&
    a.type === b.type &&
    a.size === b.size &&
    a.amount === b.amount &&
    a.price === b.price;

  it('dos pedidos tienen la misma huella si y solo si piden lo mismo', () => {
    // El rango de valores es chico a propósito, para que salgan pedidos iguales seguido.
    fc.assert(
      fc.property(commandArb, commandArb, (a, b) => {
        assert.equal(hashOrderRequest(a) === hashOrderRequest(b), sameRequest(a, b));
      }),
      { numRuns: 2000 },
    );
  });

  it('la huella no depende de quién pide ni de la key: solo del contenido', () => {
    fc.assert(
      fc.property(
        commandArb,
        fc.integer({ min: 1, max: 9 }),
        fc.string(),
        (command, userId, key) => {
          assert.equal(
            hashOrderRequest({ ...command, userId, idempotencyKey: key }),
            hashOrderRequest(command),
          );
        },
      ),
    );
  });
});

describe('propiedades del cálculo de tenencias', () => {
  const tradeArb = fc.record({
    instrumentId: fc.integer({ min: 1, max: 3 }),
    side: fc.constantFrom('BUY', 'SELL'),
    size: fc.integer({ min: 1, max: 500 }),
    price: positiveCents(10_000_000n),
  }) as fc.Arbitrary<Trade>;

  /** Recorta las ventas para que nunca se venda más de lo que hay, como garantiza la API. */
  function withoutOverselling(trades: Trade[]): Trade[] {
    const held = new Map<number, number>();
    const valid: Trade[] = [];
    for (const trade of trades) {
      const quantity = held.get(trade.instrumentId) ?? 0;
      const size = trade.side === 'BUY' ? trade.size : Math.min(trade.size, quantity);
      if (size === 0) continue;
      held.set(trade.instrumentId, quantity + (trade.side === 'BUY' ? size : -size));
      valid.push({ ...trade, size });
    }
    return valid;
  }

  const validTrades = fc.array(tradeArb, { maxLength: 40 }).map(withoutOverselling);

  it('la cantidad es compras menos ventas, y nunca queda negativa', () => {
    fc.assert(
      fc.property(validTrades, (trades) => {
        for (const holding of foldTrades(trades)) {
          const mine = trades.filter((trade) => trade.instrumentId === holding.instrumentId);
          const net = mine.reduce((sum, t) => sum + (t.side === 'BUY' ? t.size : -t.size), 0);
          assert.equal(holding.quantity, net);
          assert.ok(holding.quantity >= 0);
        }
      }),
    );
  });

  it('el costo nunca es negativo y es cero exactamente cuando no queda tenencia', () => {
    fc.assert(
      fc.property(validTrades, (trades) => {
        for (const holding of foldTrades(trades)) {
          assert.ok(holding.costBasis >= 0n);
          assert.equal(holding.costBasis === 0n, holding.quantity === 0);
        }
      }),
    );
  });

  it('el costo promedio queda entre el precio de compra más bajo y el más alto', () => {
    fc.assert(
      fc.property(validTrades, (trades) => {
        for (const holding of foldTrades(trades)) {
          if (holding.quantity === 0) continue;
          const mine = trades.filter((trade) => trade.instrumentId === holding.instrumentId);
          const buys = mine.filter((trade) => trade.side === 'BUY').map((trade) => trade.price);
          const sells = BigInt(mine.length - buys.length);
          const sorted = [...buys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          const lowest = sorted[0] as bigint;
          const highest = sorted.at(-1) as bigint;
          const quantity = BigInt(holding.quantity);
          // Cada venta redondea el costo que se lleva a un centavo: esa es la tolerancia.
          assert.ok(holding.costBasis >= lowest * quantity - sells);
          assert.ok(holding.costBasis <= highest * quantity + sells);
        }
      }),
    );
  });

  it('si solo hubo compras, el costo es exactamente lo pagado', () => {
    fc.assert(
      fc.property(fc.array(tradeArb, { maxLength: 30 }), (trades) => {
        const buys = trades.map((trade) => ({ ...trade, side: 'BUY' as const }));
        for (const holding of foldTrades(buys)) {
          const paid = buys
            .filter((trade) => trade.instrumentId === holding.instrumentId)
            .reduce((sum, trade) => sum + totalFor(trade.size, trade.price), 0n);
          assert.equal(holding.costBasis, paid);
        }
      }),
    );
  });

  it('las operaciones de un instrumento no afectan la tenencia de otro', () => {
    fc.assert(
      fc.property(validTrades, (trades) => {
        const all = foldTrades(trades);
        for (const instrumentId of [1, 2, 3]) {
          const alone = foldTrades(trades.filter((trade) => trade.instrumentId === instrumentId));
          assert.deepEqual(
            all.filter((holding) => holding.instrumentId === instrumentId),
            alone,
          );
        }
      }),
    );
  });

  it('valuar una posición: el valor es cantidad por precio y el signo del rendimiento es coherente', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        positiveCents(10_000_000n),
        positiveCents(10_000_000n),
        (quantity, averageCost, close) => {
          const costBasis = BigInt(quantity) * averageCost;
          const valued = valuePosition(
            { instrumentId: 1, quantity, costBasis },
            { close, previousClose: null, date: '2023-07-14' },
          );
          assert.equal(valued.marketValue, BigInt(quantity) * close);
          assert.equal(valued.averageCost, averageCost);
          const totalReturn = valued.totalReturnPercent as number;
          if (close > averageCost) assert.ok(totalReturn >= 0);
          if (close < averageCost) assert.ok(totalReturn <= 0);
          if (close === averageCost) assert.equal(totalReturn, 0);
        },
      ),
    );
  });
});

describe('propiedades del escapado de búsquedas', () => {
  it('después de escapar no queda ningún comodín activo, y el texto original se recupera', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 30 }), (text) => {
        const escaped = escapeLikePattern(text);
        // Quitando cada par "\x" no puede quedar un comodín ni una barra suelta.
        assert.doesNotMatch(escaped.replace(/\\[\\%_]/g, ''), /[\\%_]/);
        assert.equal(escaped.replace(/\\([\\%_])/g, '$1'), text);
      }),
    );
  });
});
