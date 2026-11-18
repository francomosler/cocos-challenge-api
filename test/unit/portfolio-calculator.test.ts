import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  foldTrades,
  type Trade,
  totalAccountValue,
  valuePosition,
} from '../../src/modules/portfolio/domain/portfolio-calculator.ts';

const buy = (instrumentId: number, size: number, price: bigint): Trade => ({
  instrumentId,
  side: 'BUY',
  size,
  price,
});
const sell = (instrumentId: number, size: number, price: bigint): Trade => ({
  instrumentId,
  side: 'SELL',
  size,
  price,
});

describe('foldTrades', () => {
  it('sin operaciones no hay tenencias', () => {
    assert.deepEqual(foldTrades([]), []);
  });

  it('una compra define cantidad y costo', () => {
    assert.deepEqual(foldTrades([buy(47, 50, 93000n)]), [
      { instrumentId: 47, quantity: 50, costBasis: 4_650_000n },
    ]);
  });

  it('dos compras a distinto precio promedian el costo', () => {
    const [holding] = foldTrades([buy(1, 10, 10000n), buy(1, 30, 20000n)]);
    assert.equal(holding?.quantity, 40);
    assert.equal(holding?.costBasis, 700_000n); // promedio $175
  });

  it('vender no cambia el costo promedio de lo que queda (PAMP del seed)', () => {
    // Compra 50 a $930, vende 10 a $940: quedan 40 con costo $930 c/u.
    const [holding] = foldTrades([buy(47, 50, 93000n), sell(47, 10, 94000n)]);
    assert.deepEqual(holding, { instrumentId: 47, quantity: 40, costBasis: 3_720_000n });
  });

  it('vender todo deja la tenencia en cero y sin costo', () => {
    const [holding] = foldTrades([buy(1, 10, 10000n), sell(1, 10, 15000n)]);
    assert.deepEqual(holding, { instrumentId: 1, quantity: 0, costBasis: 0n });
  });

  it('volver a comprar después de vender todo arranca un costo nuevo', () => {
    const [holding] = foldTrades([buy(1, 10, 10000n), sell(1, 10, 15000n), buy(1, 5, 30000n)]);
    assert.deepEqual(holding, { instrumentId: 1, quantity: 5, costBasis: 150_000n });
  });

  it('una posición sobrevendida queda negativa y sin costo (BMA del seed)', () => {
    // Compra 20 y vende 30: dato inconsistente que trae database.sql.
    const [holding] = foldTrades([buy(31, 20, 154000n), sell(31, 30, 153000n)]);
    assert.deepEqual(holding, { instrumentId: 31, quantity: -10, costBasis: 0n });
  });

  it('comprar sobre una posición sobrevendida solo le da costo a lo que queda en positivo', () => {
    const [holding] = foldTrades([
      buy(31, 20, 154000n),
      sell(31, 30, 153000n),
      buy(31, 25, 100000n),
    ]);
    assert.deepEqual(holding, { instrumentId: 31, quantity: 15, costBasis: 1_500_000n });
  });

  it('lleva cada instrumento por separado', () => {
    const holdings = foldTrades([buy(1, 10, 100n), buy(2, 5, 200n), sell(1, 4, 150n)]);
    assert.deepEqual(holdings, [
      { instrumentId: 1, quantity: 6, costBasis: 600n },
      { instrumentId: 2, quantity: 5, costBasis: 1000n },
    ]);
  });

  it('el orden de las operaciones importa', () => {
    const cheapFirst = foldTrades([buy(1, 10, 100n), sell(1, 5, 0n), buy(1, 10, 300n)]);
    const expensiveFirst = foldTrades([buy(1, 10, 300n), sell(1, 5, 0n), buy(1, 10, 100n)]);
    assert.equal(cheapFirst[0]?.costBasis, 3500n);
    assert.equal(expensiveFirst[0]?.costBasis, 2500n);
  });
});

describe('valuePosition', () => {
  const holding = { instrumentId: 47, quantity: 40, costBasis: 3_720_000n };

  it('valúa al último precio y calcula ambos rendimientos', () => {
    const quote = { close: 92585n, previousClose: 92180n, date: '2023-07-14' };
    assert.deepEqual(valuePosition(holding, quote), {
      quantity: 40,
      averageCost: 93000n,
      lastPrice: 92585n,
      marketValue: 3_703_400n,
      totalReturnPercent: -0.45,
      dailyReturnPercent: 0.44,
    });
  });

  it('una posición en ganancia tiene rendimiento positivo', () => {
    const quote = { close: 102300n, previousClose: 102300n, date: '2023-07-14' };
    const valued = valuePosition(holding, quote);
    assert.equal(valued.totalReturnPercent, 10);
    assert.equal(valued.dailyReturnPercent, 0);
  });

  it('sin cierre anterior no hay variación diaria', () => {
    const quote = { close: 92585n, previousClose: null, date: '2023-07-14' };
    assert.equal(valuePosition(holding, quote).dailyReturnPercent, null);
  });

  it('sin precio no se inventa una valuación', () => {
    assert.deepEqual(valuePosition(holding, null), {
      quantity: 40,
      averageCost: 93000n,
      lastPrice: null,
      marketValue: null,
      totalReturnPercent: null,
      dailyReturnPercent: null,
    });
  });
});

describe('totalAccountValue', () => {
  it('suma los pesos y el valor de mercado de las posiciones', () => {
    const positions = [
      valuePosition(
        { instrumentId: 47, quantity: 40, costBasis: 3_720_000n },
        {
          close: 92585n,
          previousClose: 92180n,
          date: '2023-07-14',
        },
      ),
      valuePosition(
        { instrumentId: 54, quantity: 500, costBasis: 12_500_000n },
        {
          close: 22950n,
          previousClose: 23200n,
          date: '2023-07-14',
        },
      ),
    ];
    assert.equal(totalAccountValue(75_300_000n, positions), 90_478_400n); // $904.784,00
  });

  it('una posición sin precio no suma', () => {
    const unpriced = valuePosition({ instrumentId: 3, quantity: 10, costBasis: 1000n }, null);
    assert.equal(totalAccountValue(5000n, [unpriced]), 5000n);
  });
});
