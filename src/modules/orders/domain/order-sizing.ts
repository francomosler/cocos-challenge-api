import { type Cents, formatCents, wholeUnitsFor } from '../../../shared/money.ts';
import { AmountBelowUnitPriceError, InvalidOrderError } from './order-errors.ts';

/** `orders.size` es INT en Postgres. */
export const MAX_ORDER_SIZE = 2_147_483_647;

/** El usuario dice cuánto quiere operar de una de dos formas. */
export type OrderQuantity =
  | { kind: 'SIZE'; size: number } // cantidad exacta de acciones
  | { kind: 'AMOUNT'; amount: Cents }; // monto total en pesos a invertir

export function quantityFrom(input: { size?: number; amount?: Cents }): OrderQuantity {
  const hasSize = input.size !== undefined;
  const hasAmount = input.amount !== undefined;

  if (hasSize && hasAmount) {
    throw new InvalidOrderError(
      'SIZE_AND_AMOUNT_ARE_EXCLUSIVE',
      'Enviá "size" o "amount", no los dos',
    );
  }
  if (input.size !== undefined) {
    if (!Number.isInteger(input.size) || input.size < 1 || input.size > MAX_ORDER_SIZE) {
      throw new InvalidOrderError(
        'SIZE_OUT_OF_RANGE',
        `"size" debe ser un entero entre 1 y ${MAX_ORDER_SIZE}`,
      );
    }
    return { kind: 'SIZE', size: input.size };
  }
  if (input.amount !== undefined) {
    if (input.amount <= 0n) {
      throw new InvalidOrderError('AMOUNT_OUT_OF_RANGE', '"amount" debe ser mayor a cero');
    }
    return { kind: 'AMOUNT', amount: input.amount };
  }
  throw new InvalidOrderError('SIZE_OR_AMOUNT_REQUIRED', 'Enviá "size" o "amount"');
}

/**
 * Cantidad de acciones de la orden. Con un monto, es la mayor cantidad entera que ese
 * monto paga al precio dado: no se admiten fracciones y lo que sobra no se usa.
 */
export function resolveSize(quantity: OrderQuantity, unitPrice: Cents): number {
  if (quantity.kind === 'SIZE') return quantity.size;

  const units = wholeUnitsFor(quantity.amount, unitPrice);
  if (units === 0n) {
    throw new AmountBelowUnitPriceError(formatCents(quantity.amount), formatCents(unitPrice));
  }
  if (units > BigInt(MAX_ORDER_SIZE)) {
    throw new InvalidOrderError(
      'SIZE_OUT_OF_RANGE',
      `El monto equivale a más de ${MAX_ORDER_SIZE} unidades`,
    );
  }
  return Number(units);
}
