import { UserNotFoundError } from '../../shared/errors.ts';
import type { Cents } from '../../shared/money.ts';
import type { UnitOfWork } from '../../shared/unit-of-work.ts';
import {
  foldTrades,
  type Holding,
  type PositionValuation,
  totalAccountValue,
  valuePosition,
} from './domain/portfolio-calculator.ts';
import type { PortfolioReadContext } from './ports.ts';

export interface PortfolioPosition extends PositionValuation {
  instrumentId: number;
  ticker: string;
  name: string;
  /** Unidades comprometidas en ventas LIMIT pendientes; no se pueden volver a vender. */
  reservedQuantity: number;
}

export interface Portfolio {
  userId: number;
  totalAccountValue: Cents;
  /** Pesos que se pueden usar ahora para operar. */
  availableCash: Cents;
  /** Pesos comprometidos en compras LIMIT pendientes. */
  reservedCash: Cents;
  positions: PortfolioPosition[];
}

export class GetPortfolio {
  private readonly snapshots: UnitOfWork<PortfolioReadContext>;

  /**
   * `snapshots` entrega las lecturas sobre una misma foto de los datos: si entra una orden
   * a mitad de camino, el portfolio no mezcla pesos de antes con acciones de después.
   */
  constructor(snapshots: UnitOfWork<PortfolioReadContext>) {
    this.snapshots = snapshots;
  }

  execute(userId: number): Promise<Portfolio> {
    return this.snapshots.run((context) => this.build(context, userId));
  }

  private async build(context: PortfolioReadContext, userId: number): Promise<Portfolio> {
    const { users, ledger } = context;
    if (!(await users.exists(userId))) throw new UserNotFoundError(userId);

    const cash = await ledger.cashSummary(userId);
    const trades = await ledger.filledTrades(userId);
    const reservedShares = await ledger.reservedShares(userId);

    // Solo son posiciones las tenencias positivas (ver "Hallazgos en los datos" del README).
    const holdings = foldTrades(trades).filter((holding) => holding.quantity > 0);
    const positions = await this.valueHoldings(context, holdings, reservedShares);

    return {
      userId,
      totalAccountValue: totalAccountValue(cash.total, positions),
      availableCash: cash.total - cash.reserved,
      reservedCash: cash.reserved,
      positions,
    };
  }

  private async valueHoldings(
    { instruments }: PortfolioReadContext,
    holdings: Holding[],
    reservedShares: Map<number, number>,
  ): Promise<PortfolioPosition[]> {
    const quoted = await instruments.findWithQuotes(holdings.map((h) => h.instrumentId));
    const byId = new Map(quoted.map((instrument) => [instrument.id, instrument]));

    return holdings
      .flatMap((holding) => {
        const instrument = byId.get(holding.instrumentId);
        if (!instrument) return [];
        return [
          {
            instrumentId: instrument.id,
            ticker: instrument.ticker,
            name: instrument.name,
            reservedQuantity: reservedShares.get(instrument.id) ?? 0,
            ...valuePosition(holding, instrument.quote),
          },
        ];
      })
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  }
}
