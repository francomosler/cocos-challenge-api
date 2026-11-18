import type { Static } from 'typebox';
import {
  type Cents,
  centsToNumber,
  InvalidMoneyError,
  parseCents,
  totalFor,
} from '../../shared/money.ts';
import type { Order } from './domain/order.ts';
import { InvalidOrderError } from './domain/order-errors.ts';
import type { OrderResponse, PlaceOrderBody } from './order.schemas.ts';
import type { PlaceOrderCommand } from './place-order.ts';

/** Del dominio (centavos exactos) a la respuesta JSON (pesos). */
export function presentOrder(order: Order): Static<typeof OrderResponse> {
  return {
    id: order.id,
    userId: order.userId,
    instrumentId: order.instrumentId,
    side: order.side,
    type: order.type,
    status: order.status,
    size: order.size,
    price: centsToNumber(order.price),
    total: centsToNumber(totalFor(order.size, order.price)),
    rejectionReason: order.rejectionReason,
    datetime: order.datetime.toISOString(),
  };
}

/** Los importes llegan como número JSON y entran al dominio como centavos exactos. */
function toCents(field: 'amount' | 'price', value: number | undefined): Cents | undefined {
  if (value === undefined) return undefined;
  try {
    return parseCents(value);
  } catch (error) {
    if (!(error instanceof InvalidMoneyError)) throw error;
    throw new InvalidOrderError(
      'INVALID_MONEY_VALUE',
      `"${field}" debe ser un importe en pesos con hasta 2 decimales`,
      { field, value },
    );
  }
}

/** Del pedido HTTP al comando del caso de uso. Solo incluye lo que el cliente envió. */
export function toPlaceOrderCommand(
  userId: number,
  idempotencyKey: string,
  body: Static<typeof PlaceOrderBody>,
): PlaceOrderCommand {
  const amount = toCents('amount', body.amount);
  const price = toCents('price', body.price);
  return {
    userId,
    idempotencyKey,
    instrumentId: body.instrumentId,
    side: body.side,
    type: body.type,
    ...(body.size !== undefined ? { size: body.size } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(price !== undefined ? { price } : {}),
  };
}
