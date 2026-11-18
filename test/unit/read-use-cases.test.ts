import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QuotedInstrument } from '../../src/modules/instruments/domain/instrument.ts';
import {
  DEFAULT_SEARCH_LIMIT,
  SearchInstruments,
} from '../../src/modules/instruments/search-instruments.ts';
import type { Trade } from '../../src/modules/portfolio/domain/portfolio-calculator.ts';
import { GetPortfolio } from '../../src/modules/portfolio/get-portfolio.ts';
import type { PortfolioReadContext } from '../../src/modules/portfolio/ports.ts';
import { InvalidRequestError, UserNotFoundError } from '../../src/shared/errors.ts';
import type { UnitOfWork } from '../../src/shared/unit-of-work.ts';
import { InMemoryInstruments, InMemoryUsers } from '../helpers/in-memory.ts';

const quoted = (
  id: number,
  ticker: string,
  close: bigint | null,
  previousClose: bigint | null = null,
): QuotedInstrument => ({
  id,
  ticker,
  name: `${ticker} S.A.`,
  type: 'ACCIONES',
  quote: close === null ? null : { close, previousClose, date: '2023-07-14' },
});

const CATALOG = [
  quoted(47, 'PAMP', 92585n, 92180n),
  quoted(54, 'METR', 22950n, 23200n),
  quoted(3, 'PGR', null),
];

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

interface Account {
  cashTotal: bigint;
  cashReserved?: bigint;
  trades?: Trade[];
  reservedShares?: Record<number, number>;
}

/** Fuente de lecturas en memoria que cuenta cuántas unidades de trabajo se abrieron. */
function snapshotsOf(account: Account, catalog: QuotedInstrument[] = CATALOG) {
  const source = {
    runs: 0,
    async run<T>(work: (context: PortfolioReadContext) => Promise<T>): Promise<T> {
      source.runs++;
      return work({
        users: new InMemoryUsers([1]),
        instruments: new InMemoryInstruments(catalog),
        ledger: {
          cashSummary: async () => ({
            total: account.cashTotal,
            reserved: account.cashReserved ?? 0n,
          }),
          filledTrades: async () => account.trades ?? [],
          reservedShares: async () =>
            new Map(Object.entries(account.reservedShares ?? {}).map(([id, n]) => [Number(id), n])),
        },
      });
    },
  } satisfies UnitOfWork<PortfolioReadContext> & { runs: number };
  return source;
}

describe('GetPortfolio', () => {
  it('arma el portfolio del usuario 1 del challenge', async () => {
    const snapshots = snapshotsOf({
      cashTotal: 75_300_000n,
      cashReserved: 12_550_000n,
      trades: [buy(47, 50, 93000n), sell(47, 10, 94000n), buy(54, 500, 25000n)],
    });

    const portfolio = await new GetPortfolio(snapshots).execute(1);

    assert.equal(portfolio.totalAccountValue, 90_478_400n); // $904.784,00
    assert.equal(portfolio.availableCash, 62_750_000n); // $627.500,00
    assert.equal(portfolio.reservedCash, 12_550_000n);
    assert.deepEqual(
      portfolio.positions.map((p) => [p.ticker, p.quantity, p.marketValue, p.totalReturnPercent]),
      [
        ['METR', 500, 11_475_000n, -8.2],
        ['PAMP', 40, 3_703_400n, -0.45],
      ],
    );
  });

  it('lee todo dentro de una única unidad de trabajo, para ver una sola foto', async () => {
    const snapshots = snapshotsOf({ cashTotal: 1000n, trades: [buy(47, 1, 100n)] });
    await new GetPortfolio(snapshots).execute(1);
    assert.equal(snapshots.runs, 1);
  });

  it('un usuario inexistente no tiene portfolio', async () => {
    await assert.rejects(
      new GetPortfolio(snapshotsOf({ cashTotal: 0n })).execute(999),
      UserNotFoundError,
    );
  });

  it('una cuenta sin movimientos queda en cero y sin posiciones', async () => {
    assert.deepEqual(await new GetPortfolio(snapshotsOf({ cashTotal: 0n })).execute(1), {
      userId: 1,
      totalAccountValue: 0n,
      availableCash: 0n,
      reservedCash: 0n,
      positions: [],
    });
  });

  it('las tenencias en cero o negativas no son posiciones', async () => {
    const snapshots = snapshotsOf({
      cashTotal: 0n,
      trades: [
        buy(47, 10, 100n),
        sell(47, 10, 100n), // quedó en cero
        buy(54, 20, 100n),
        sell(54, 30, 100n), // quedó en −10
      ],
    });
    assert.deepEqual((await new GetPortfolio(snapshots).execute(1)).positions, []);
  });

  it('una posición sin precio se lista, pero no suma al valor de la cuenta', async () => {
    const snapshots = snapshotsOf({ cashTotal: 50_000n, trades: [buy(3, 10, 1000n)] });

    const portfolio = await new GetPortfolio(snapshots).execute(1);

    assert.equal(portfolio.totalAccountValue, 50_000n);
    assert.equal(portfolio.positions[0]?.ticker, 'PGR');
    assert.equal(portfolio.positions[0]?.quantity, 10);
    assert.equal(portfolio.positions[0]?.marketValue, null);
    assert.equal(portfolio.positions[0]?.totalReturnPercent, null);
  });

  it('informa las acciones reservadas de cada posición', async () => {
    const snapshots = snapshotsOf({
      cashTotal: 0n,
      trades: [buy(47, 10, 100n), buy(54, 5, 100n)],
      reservedShares: { 47: 4 },
    });

    const positions = (await new GetPortfolio(snapshots).execute(1)).positions;

    assert.deepEqual(
      positions.map((p) => [p.ticker, p.reservedQuantity]),
      [
        ['METR', 0],
        ['PAMP', 4],
      ],
    );
  });

  it('si una tenencia apunta a un instrumento que ya no está en el catálogo, la omite', async () => {
    const snapshots = snapshotsOf({ cashTotal: 0n, trades: [buy(999, 1, 100n), buy(47, 1, 100n)] });
    const tickers = (await new GetPortfolio(snapshots).execute(1)).positions.map((p) => p.ticker);
    assert.deepEqual(tickers, ['PAMP']);
  });

  it('el valor total incluye los pesos reservados: siguen siendo del usuario', async () => {
    const snapshots = snapshotsOf({ cashTotal: 100_000n, cashReserved: 100_000n });
    const portfolio = await new GetPortfolio(snapshots).execute(1);
    assert.equal(portfolio.availableCash, 0n);
    assert.equal(portfolio.totalAccountValue, 100_000n);
  });
});

describe('SearchInstruments', () => {
  it('busca el texto sin los espacios de los bordes y con el límite por defecto', async () => {
    const catalog = new InMemoryInstruments(CATALOG);

    const found = await new SearchInstruments(catalog).execute('  pam ');

    assert.deepEqual(catalog.searches, [{ text: 'pam', limit: DEFAULT_SEARCH_LIMIT }]);
    assert.deepEqual(
      found.map((instrument) => instrument.ticker),
      ['PAMP'],
    );
  });

  it('respeta el límite pedido', async () => {
    const catalog = new InMemoryInstruments(CATALOG);
    await new SearchInstruments(catalog).execute('p', 5);
    assert.deepEqual(catalog.searches, [{ text: 'p', limit: 5 }]);
  });

  it('una búsqueda vacía se rechaza sin consultar el catálogo', async () => {
    const catalog = new InMemoryInstruments(CATALOG);
    await assert.rejects(new SearchInstruments(catalog).execute('   '), InvalidRequestError);
    assert.deepEqual(catalog.searches, []);
  });
});
