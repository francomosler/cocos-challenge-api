import type { Cents } from '../../../shared/money.ts';

/** Lados que la API permite enviar. */
export const TRADE_SIDES = ['BUY', 'SELL'] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

/** En la tabla también hay transferencias, modeladas como órdenes. */
export type OrderSide = TradeSide | 'CASH_IN' | 'CASH_OUT';

export const ORDER_TYPES = ['MARKET', 'LIMIT'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = ['NEW', 'FILLED', 'REJECTED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const REJECTION_REASONS = ['INSUFFICIENT_FUNDS', 'INSUFFICIENT_SHARES'] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface Order {
  id: number;
  userId: number;
  instrumentId: number;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  size: number;
  /** Precio por unidad: el `close` usado en una MARKET o el límite de una LIMIT. */
  price: Cents;
  rejectionReason: RejectionReason | null;
  datetime: Date;
}

export function isTradeSide(side: OrderSide): side is TradeSide {
  return side === 'BUY' || side === 'SELL';
}
