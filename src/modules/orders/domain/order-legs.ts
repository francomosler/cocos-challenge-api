import { InvariantViolationError } from '../../../shared/errors.ts';
import { type Cents, formatCents, totalFor } from '../../../shared/money.ts';
import type { OrderSide, RejectionReason, TradeSide } from './order.ts';

/** Cantidad de un activo, como decimal listo para una columna NUMERIC. */
export interface AssetAmount {
  instrumentId: number;
  amount: string;
}

/**
 * Toda orden de compra o venta es un intercambio de dos activos:
 * entrega uno (`debit`) y recibe otro (`credit`).
 *
 *   BUY:  entrega pesos (size × price)  y recibe acciones (size)
 *   SELL: entrega acciones (size)       y recibe pesos (size × price)
 *
 * Con esto, "¿le alcanza?" es siempre la misma pregunta —¿hay `debit` disponible?— y
 * el caso de uso no distingue compras de ventas.
 */
export interface OrderLegs {
  debit: AssetAmount;
  credit: AssetAmount;
  /** Motivo de rechazo cuando lo que hay que entregar no alcanza. */
  shortfall: RejectionReason;
}

export interface TradeTerms {
  side: OrderSide;
  instrumentId: number;
  size: number;
  price: Cents;
}

type LegBuilder = (shares: AssetAmount, cash: AssetAmount) => OrderLegs;

const LEGS_BY_SIDE: Record<TradeSide, LegBuilder> = {
  BUY: (shares, cash) => ({ debit: cash, credit: shares, shortfall: 'INSUFFICIENT_FUNDS' }),
  SELL: (shares, cash) => ({ debit: shares, credit: cash, shortfall: 'INSUFFICIENT_SHARES' }),
};

export function legsFor(terms: TradeTerms, cashInstrumentId: number): OrderLegs {
  if (terms.side !== 'BUY' && terms.side !== 'SELL') {
    throw new InvariantViolationError(`Una orden ${terms.side} no es un intercambio de activos`);
  }
  const shares: AssetAmount = { instrumentId: terms.instrumentId, amount: String(terms.size) };
  const cash: AssetAmount = {
    instrumentId: cashInstrumentId,
    amount: formatCents(totalFor(terms.size, terms.price)),
  };
  return LEGS_BY_SIDE[terms.side](shares, cash);
}
