import { type Cents, percentChange, roundDivide, totalFor } from '../../../shared/money.ts';
import { dailyReturnPercent, type Quote } from '../../instruments/domain/instrument.ts';

/** Una compra o venta ejecutada (orden FILLED). */
export interface Trade {
  instrumentId: number;
  side: 'BUY' | 'SELL';
  size: number;
  price: Cents;
}

/** Tenencia de un instrumento reconstruida desde sus operaciones. */
export interface Holding {
  instrumentId: number;
  quantity: number;
  /** Lo pagado por las unidades que todavía se tienen. */
  costBasis: Cents;
}

export interface PositionValuation {
  quantity: number;
  averageCost: Cents;
  lastPrice: Cents | null;
  marketValue: Cents | null;
  /** Rendimiento desde la compra: valor de mercado contra costo. */
  totalReturnPercent: number | null;
  /** Variación del día: `close` contra `previousClose`. */
  dailyReturnPercent: number | null;
}

/**
 * Reconstruye la tenencia por instrumento a partir de las operaciones en orden cronológico,
 * con el método de costo promedio ponderado:
 *
 * - Comprar suma cantidad y suma costo.
 * - Vender resta cantidad y resta costo en la misma proporción, así el costo promedio de
 *   lo que queda no cambia.
 * - Si la tenencia llega a cero (o por debajo, por datos inconsistentes), el costo se
 *   reinicia: una compra posterior arranca un costo promedio nuevo.
 */
export function foldTrades(trades: readonly Trade[]): Holding[] {
  const holdings = new Map<number, Holding>();

  for (const trade of trades) {
    const holding = holdings.get(trade.instrumentId) ?? {
      instrumentId: trade.instrumentId,
      quantity: 0,
      costBasis: 0n,
    };
    holdings.set(
      trade.instrumentId,
      trade.side === 'BUY' ? buy(holding, trade) : sell(holding, trade),
    );
  }
  return [...holdings.values()];
}

function buy(holding: Holding, trade: Trade): Holding {
  const quantity = holding.quantity + trade.size;
  if (holding.quantity >= 0) {
    return {
      ...holding,
      quantity,
      costBasis: holding.costBasis + totalFor(trade.size, trade.price),
    };
  }
  // Venía sobrevendida: solo tienen costo las unidades que quedan en positivo.
  return { ...holding, quantity, costBasis: quantity > 0 ? totalFor(quantity, trade.price) : 0n };
}

function sell(holding: Holding, trade: Trade): Holding {
  const quantity = holding.quantity - trade.size;
  if (quantity <= 0) return { ...holding, quantity, costBasis: 0n };
  const soldCost = roundDivide(holding.costBasis * BigInt(trade.size), BigInt(holding.quantity));
  return { ...holding, quantity, costBasis: holding.costBasis - soldCost };
}

/** Valúa una tenencia positiva al último precio conocido. Sin precio, no hay valuación. */
export function valuePosition(holding: Holding, quote: Quote | null): PositionValuation {
  const averageCost = roundDivide(holding.costBasis, BigInt(holding.quantity));
  if (!quote) {
    return {
      quantity: holding.quantity,
      averageCost,
      lastPrice: null,
      marketValue: null,
      totalReturnPercent: null,
      dailyReturnPercent: null,
    };
  }
  const marketValue = totalFor(holding.quantity, quote.close);
  return {
    quantity: holding.quantity,
    averageCost,
    lastPrice: quote.close,
    marketValue,
    totalReturnPercent: percentChange(holding.costBasis, marketValue),
    dailyReturnPercent: dailyReturnPercent(quote),
  };
}

/** Valor total de la cuenta: todos los pesos (libres y reservados) más las posiciones valuadas. */
export function totalAccountValue(
  cashTotal: Cents,
  positions: readonly PositionValuation[],
): Cents {
  return positions.reduce((sum, position) => sum + (position.marketValue ?? 0n), cashTotal);
}
