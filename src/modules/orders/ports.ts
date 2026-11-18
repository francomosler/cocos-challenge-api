import type { Cents } from '../../shared/money.ts';
import type { Order, OrderSide, OrderStatus, OrderType, RejectionReason } from './domain/order.ts';
import type { AssetAmount } from './domain/order-legs.ts';

export interface NewOrder {
  userId: number;
  instrumentId: number;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  size: number;
  price: Cents;
  rejectionReason: RejectionReason | null;
  idempotencyKey: string;
  requestHash: string;
}

/** Una orden junto con la huella del pedido que la creó. */
export interface OrderWithRequestHash {
  order: Order;
  requestHash: string | null;
}

/** Ya existe una orden de ese usuario con esa Idempotency-Key. */
export class DuplicateIdempotencyKeyError extends Error {
  constructor() {
    super('Ya existe una orden con esa Idempotency-Key');
    this.name = 'DuplicateIdempotencyKeyError';
  }
}

/** Almacén de órdenes. */
export interface OrderStore {
  /**
   * Graba la orden. Una misma Idempotency-Key no puede grabarse dos veces para un usuario,
   * ni siquiera con pedidos simultáneos: el segundo falla con `DuplicateIdempotencyKeyError`.
   */
  insert(order: NewOrder): Promise<Order>;

  findByIdempotencyKey(
    userId: number,
    idempotencyKey: string,
  ): Promise<OrderWithRequestHash | null>;

  findById(orderId: number, userId: number): Promise<Order | null>;

  /**
   * Cambia el estado de la orden solo si su estado actual es uno de `allowedFrom`, de forma
   * atómica: con pedidos simultáneos, uno solo recibe la orden y los demás `null`.
   */
  transition(
    orderId: number,
    userId: number,
    to: OrderStatus,
    allowedFrom: readonly OrderStatus[],
  ): Promise<Order | null>;
}

/**
 * Saldos por cuenta y activo. Cada operación es atómica: decide y aplica en un solo paso,
 * así dos pedidos simultáneos nunca deciden sobre el mismo saldo.
 */
export interface BalanceStore {
  /** Aparta `asset` (disponible → reservado) si alcanza. Devuelve si pudo. */
  reserve(userId: number, asset: AssetAmount): Promise<boolean>;

  /** Devuelve una reserva al disponible (reservado → disponible). */
  release(userId: number, asset: AssetAmount): Promise<void>;

  /**
   * Intercambio inmediato: entrega `debit` si alcanza y, solo entonces, recibe `credit`.
   * Devuelve si se hizo; si no alcanza, no modifica nada.
   */
  exchange(userId: number, debit: AssetAmount, credit: AssetAmount): Promise<boolean>;
}

/** Lo que una escritura de órdenes usa dentro de una unidad de trabajo. */
export interface OrderWriteContext {
  orders: OrderStore;
  balances: BalanceStore;
}
