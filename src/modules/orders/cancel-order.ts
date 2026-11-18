import type { Logger } from '../../shared/logger.ts';
import type { UnitOfWork } from '../../shared/unit-of-work.ts';
import type { Order } from './domain/order.ts';
import { OrderNotCancellableError, OrderNotFoundError } from './domain/order-errors.ts';
import { legsFor } from './domain/order-legs.ts';
import { sourcesOf } from './domain/order-status.ts';
import type { OrderStore, OrderWriteContext } from './ports.ts';

/** Qué estados admiten cancelación lo decide la máquina de estados (hoy, solo NEW). */
const CANCELLABLE_FROM = sourcesOf('CANCELLED');

export interface CancelOrderCommand {
  userId: number;
  orderId: number;
}

export interface CancelOrderResult {
  order: Order;
  /** `true` si la orden ya estaba cancelada y este pedido no cambió nada. */
  alreadyCancelled: boolean;
}

export interface CancelOrderDependencies {
  /** Lectura suelta de órdenes, fuera de la unidad de trabajo. */
  orders: Pick<OrderStore, 'findById'>;
  /** Escrituras: el cambio de estado y la devolución de la reserva se confirman juntos. */
  unitOfWork: UnitOfWork<OrderWriteContext>;
  cashInstrumentId: number;
}

export class CancelOrder {
  private readonly deps: CancelOrderDependencies;

  constructor(deps: CancelOrderDependencies) {
    this.deps = deps;
  }

  async execute(command: CancelOrderCommand, log: Logger): Promise<CancelOrderResult> {
    const cancelled = await this.cancelAndRelease(command);
    if (cancelled) {
      log.info(
        { event: 'order.cancelled', orderId: cancelled.id, userId: cancelled.userId },
        'Orden cancelada',
      );
      return { order: cancelled, alreadyCancelled: false };
    }
    return this.explainWhyNotCancelled(command, log);
  }

  /**
   * Solo el pedido que logra la transición a CANCELLED libera la reserva, así que por más
   * cancelaciones simultáneas que lleguen el saldo se devuelve una sola vez.
   */
  private cancelAndRelease({ userId, orderId }: CancelOrderCommand): Promise<Order | null> {
    return this.deps.unitOfWork.run(async ({ orders, balances }) => {
      const order = await orders.transition(orderId, userId, 'CANCELLED', CANCELLABLE_FROM);
      if (!order) return null;
      const reserved = legsFor(order, this.deps.cashInstrumentId).debit;
      await balances.release(userId, reserved);
      return order;
    });
  }

  /** La orden no estaba en NEW: se distingue si no existe, ya estaba cancelada o es final. */
  private async explainWhyNotCancelled(
    { userId, orderId }: CancelOrderCommand,
    log: Logger,
  ): Promise<CancelOrderResult> {
    const order = await this.deps.orders.findById(orderId, userId);
    if (!order) throw new OrderNotFoundError(orderId, userId);
    if (order.status !== 'CANCELLED') throw new OrderNotCancellableError(order.id, order.status);

    // Cancelar algo ya cancelado no es un error: el cliente pidió ese estado y lo tiene.
    log.info(
      { event: 'order.cancel_repeated', orderId: order.id, userId: order.userId },
      'La orden ya estaba cancelada',
    );
    return { order, alreadyCancelled: true };
  }
}
