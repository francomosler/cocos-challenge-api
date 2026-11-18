import { ORDER_STATUSES, type OrderStatus } from './order.ts';

/**
 * Máquina de estados de una orden. FILLED, REJECTED y CANCELLED son finales.
 *
 *   NEW ──► FILLED      (el mercado la ejecuta)
 *   NEW ──► CANCELLED   (el usuario la cancela)
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  NEW: ['FILLED', 'CANCELLED'],
  FILLED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Estados desde los que se puede llegar a `to`. */
export function sourcesOf(to: OrderStatus): OrderStatus[] {
  return ORDER_STATUSES.filter((from) => canTransition(from, to));
}

export function isFinal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
