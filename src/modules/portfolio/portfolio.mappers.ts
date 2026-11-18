import type { Static } from 'typebox';
import { type Cents, centsToNumber } from '../../shared/money.ts';
import type { Portfolio, PortfolioPosition } from './get-portfolio.ts';
import type { PortfolioResponse } from './portfolio.schemas.ts';

type PortfolioJson = Static<typeof PortfolioResponse>;

const optionalMoney = (cents: Cents | null): number | null =>
  cents === null ? null : centsToNumber(cents);

function presentPosition(position: PortfolioPosition): PortfolioJson['positions'][number] {
  return {
    instrumentId: position.instrumentId,
    ticker: position.ticker,
    name: position.name,
    quantity: position.quantity,
    reservedQuantity: position.reservedQuantity,
    averageCost: centsToNumber(position.averageCost),
    lastPrice: optionalMoney(position.lastPrice),
    marketValue: optionalMoney(position.marketValue),
    totalReturnPercent: position.totalReturnPercent,
    dailyReturnPercent: position.dailyReturnPercent,
  };
}

/** Del dominio (centavos exactos) a la respuesta JSON (pesos). */
export function presentPortfolio(portfolio: Portfolio): PortfolioJson {
  return {
    userId: portfolio.userId,
    totalAccountValue: centsToNumber(portfolio.totalAccountValue),
    availableCash: centsToNumber(portfolio.availableCash),
    reservedCash: centsToNumber(portfolio.reservedCash),
    positions: portfolio.positions.map(presentPosition),
  };
}
