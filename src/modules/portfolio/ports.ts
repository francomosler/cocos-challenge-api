import type { Cents } from '../../shared/money.ts';
import type { InstrumentCatalog } from '../instruments/ports.ts';
import type { UserDirectory } from '../users/ports.ts';
import type { Trade } from './domain/portfolio-calculator.ts';

export interface CashSummary {
  /** Pesos de la cuenta según las órdenes ejecutadas, incluido lo reservado. */
  total: Cents;
  /** Pesos comprometidos por compras LIMIT pendientes (NEW). */
  reserved: Cents;
}

/** Los movimientos de una cuenta, leídos de las órdenes. */
export interface PortfolioLedger {
  cashSummary(userId: number): Promise<CashSummary>;

  /** Compras y ventas ejecutadas, de la más vieja a la más nueva. */
  filledTrades(userId: number): Promise<Trade[]>;

  /** Acciones comprometidas por ventas LIMIT pendientes (NEW), por instrumento. */
  reservedShares(userId: number): Promise<Map<number, number>>;
}

/**
 * Todo lo que el portfolio necesita leer. Se entrega dentro de una unidad de trabajo para
 * que las lecturas vean una misma foto de los datos.
 */
export interface PortfolioReadContext {
  users: UserDirectory;
  ledger: PortfolioLedger;
  instruments: Pick<InstrumentCatalog, 'findWithQuotes'>;
}
