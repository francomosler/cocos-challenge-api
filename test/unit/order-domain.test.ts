import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ORDER_STATUSES, type OrderStatus } from '../../src/modules/orders/domain/order.ts';
import {
  AmountBelowUnitPriceError,
  InvalidOrderError,
  MarketPriceUnavailableError,
} from '../../src/modules/orders/domain/order-errors.ts';
import { legsFor } from '../../src/modules/orders/domain/order-legs.ts';
import {
  MAX_ORDER_SIZE,
  quantityFrom,
  resolveSize,
} from '../../src/modules/orders/domain/order-sizing.ts';
import { canTransition, isFinal, sourcesOf } from '../../src/modules/orders/domain/order-status.ts';
import { MAX_PRICE, strategyFor } from '../../src/modules/orders/domain/order-type.ts';
import { InvariantViolationError } from '../../src/shared/errors.ts';

const hasCode = (code: string) => (error: unknown) =>
  error instanceof InvalidOrderError && error.code === code;

describe('cantidad de la orden', () => {
  it('acepta una cantidad exacta de acciones', () => {
    assert.deepEqual(quantityFrom({ size: 10 }), { kind: 'SIZE', size: 10 });
  });

  it('acepta un monto en pesos', () => {
    assert.deepEqual(quantityFrom({ amount: 100_000n }), { kind: 'AMOUNT', amount: 100_000n });
  });

  it('rechaza cantidad y monto juntos', () => {
    assert.throws(
      () => quantityFrom({ size: 1, amount: 100n }),
      hasCode('SIZE_AND_AMOUNT_ARE_EXCLUSIVE'),
    );
  });

  it('rechaza que no venga ninguno', () => {
    assert.throws(() => quantityFrom({}), hasCode('SIZE_OR_AMOUNT_REQUIRED'));
  });

  for (const size of [0, -1, 1.5, MAX_ORDER_SIZE + 1, Number.NaN]) {
    it(`rechaza size = ${size}`, () => {
      assert.throws(() => quantityFrom({ size }), hasCode('SIZE_OUT_OF_RANGE'));
    });
  }

  it('rechaza un monto que no es positivo', () => {
    assert.throws(() => quantityFrom({ amount: 0n }), hasCode('AMOUNT_OUT_OF_RANGE'));
  });

  it('con cantidad exacta, el precio no cambia el tamaño', () => {
    assert.equal(resolveSize({ kind: 'SIZE', size: 7 }, 92585n), 7);
  });

  const byAmount: Array<[bigint, bigint, number]> = [
    [100_000n, 92585n, 1], // $1.000 a $925,85 → 1 acción, sobran $74,15
    [185_170n, 92585n, 2], // justo 2
    [185_169n, 92585n, 1], // falta 1 centavo para la segunda
    [1_000_000n, 6000n, 166], // $10.000 a $60 → 166 (no 166,67)
    [2050n, 2050n, 1],
  ];
  for (const [amount, price, expected] of byAmount) {
    it(`con monto ${amount} y precio ${price} (centavos) opera ${expected}`, () => {
      assert.equal(resolveSize({ kind: 'AMOUNT', amount }, price), expected);
    });
  }

  it('rechaza un monto que no alcanza para una acción', () => {
    assert.throws(
      () => resolveSize({ kind: 'AMOUNT', amount: 92584n }, 92585n),
      AmountBelowUnitPriceError,
    );
  });

  it('rechaza un monto que equivale a más acciones de las que entran en la columna', () => {
    const amount = BigInt(MAX_ORDER_SIZE + 1) * 1n;
    assert.throws(() => resolveSize({ kind: 'AMOUNT', amount }, 1n), hasCode('SIZE_OUT_OF_RANGE'));
  });
});

describe('estrategia por tipo de orden', () => {
  const market = strategyFor('MARKET');
  const limit = strategyFor('LIMIT');

  it('MARKET se ejecuta ya, al último precio de mercado', () => {
    assert.equal(market.acceptedStatus, 'FILLED');
    assert.equal(market.settlement, 'FILL');
    assert.equal(market.needsMarketPrice, true);
    assert.equal(
      market.resolvePrice({ instrumentId: 47, requestedPrice: null, lastClose: 92585n }),
      92585n,
    );
  });

  it('MARKET no admite que el usuario envíe precio', () => {
    assert.throws(
      () => market.resolvePrice({ instrumentId: 47, requestedPrice: 100n, lastClose: 92585n }),
      hasCode('PRICE_NOT_ALLOWED'),
    );
  });

  it('MARKET no se puede valuar si el instrumento no tiene precio', () => {
    assert.throws(
      () => market.resolvePrice({ instrumentId: 3, requestedPrice: null, lastClose: null }),
      MarketPriceUnavailableError,
    );
  });

  it('LIMIT queda pendiente, reservando, al precio que pide el usuario', () => {
    assert.equal(limit.acceptedStatus, 'NEW');
    assert.equal(limit.settlement, 'RESERVE');
    assert.equal(limit.needsMarketPrice, false);
    assert.equal(
      limit.resolvePrice({ instrumentId: 47, requestedPrice: 90000n, lastClose: null }),
      90000n,
    );
  });

  it('LIMIT exige precio', () => {
    assert.throws(
      () => limit.resolvePrice({ instrumentId: 47, requestedPrice: null, lastClose: 92585n }),
      hasCode('PRICE_REQUIRED'),
    );
  });

  for (const price of [0n, -1n, MAX_PRICE + 1n]) {
    it(`LIMIT rechaza el precio ${price}`, () => {
      assert.throws(
        () => limit.resolvePrice({ instrumentId: 47, requestedPrice: price, lastClose: null }),
        hasCode('PRICE_OUT_OF_RANGE'),
      );
    });
  }

  it('LIMIT acepta el precio máximo de la columna', () => {
    assert.equal(
      limit.resolvePrice({ instrumentId: 47, requestedPrice: MAX_PRICE, lastClose: null }),
      MAX_PRICE,
    );
  });
});

describe('patas de la orden', () => {
  const CASH = 66;
  const terms = { instrumentId: 47, size: 10, price: 92585n };

  it('una compra entrega pesos y recibe acciones', () => {
    assert.deepEqual(legsFor({ ...terms, side: 'BUY' }, CASH), {
      debit: { instrumentId: CASH, amount: '9258.50' },
      credit: { instrumentId: 47, amount: '10' },
      shortfall: 'INSUFFICIENT_FUNDS',
    });
  });

  it('una venta entrega acciones y recibe pesos', () => {
    assert.deepEqual(legsFor({ ...terms, side: 'SELL' }, CASH), {
      debit: { instrumentId: 47, amount: '10' },
      credit: { instrumentId: CASH, amount: '9258.50' },
      shortfall: 'INSUFFICIENT_SHARES',
    });
  });

  it('una transferencia no es un intercambio de activos', () => {
    assert.throws(() => legsFor({ ...terms, side: 'CASH_IN' }, CASH), InvariantViolationError);
  });
});

describe('máquina de estados', () => {
  const allowed: Array<[OrderStatus, OrderStatus]> = [
    ['NEW', 'FILLED'],
    ['NEW', 'CANCELLED'],
  ];

  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      const expected = allowed.some(([a, b]) => a === from && b === to);
      it(`${from} → ${to}: ${expected ? 'permitida' : 'prohibida'}`, () => {
        assert.equal(canTransition(from, to), expected);
      });
    }
  }

  it('solo se puede cancelar desde NEW', () => {
    assert.deepEqual(sourcesOf('CANCELLED'), ['NEW']);
  });

  it('nada vuelve a NEW ni llega a REJECTED por una transición', () => {
    assert.deepEqual(sourcesOf('NEW'), []);
    assert.deepEqual(sourcesOf('REJECTED'), []);
  });

  it('FILLED, REJECTED y CANCELLED son finales', () => {
    assert.deepEqual(ORDER_STATUSES.filter(isFinal), ['FILLED', 'REJECTED', 'CANCELLED']);
  });
});
