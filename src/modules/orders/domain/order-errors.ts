import {
  BusinessRuleError,
  ConflictError,
  type ErrorDetails,
  InvalidRequestError,
  NotFoundError,
} from '../../../shared/errors.ts';
import type { OrderStatus } from './order.ts';

/** El pedido de orden es incoherente (falta o sobra un dato, valor fuera de rango). */
export class InvalidOrderError extends InvalidRequestError {
  constructor(code: string, message: string, details?: ErrorDetails) {
    super(code, message, details);
  }
}

export class InstrumentNotTradableError extends BusinessRuleError {
  constructor(instrumentId: number, ticker: string) {
    super('INSTRUMENT_NOT_TRADABLE', `El instrumento ${ticker} no se puede comprar ni vender`, {
      instrumentId,
      ticker,
    });
  }
}

export class MarketPriceUnavailableError extends BusinessRuleError {
  constructor(instrumentId: number) {
    super(
      'MARKET_PRICE_UNAVAILABLE',
      `El instrumento ${instrumentId} no tiene precio de mercado; solo admite órdenes LIMIT`,
      { instrumentId },
    );
  }
}

export class AmountBelowUnitPriceError extends BusinessRuleError {
  constructor(amount: string, unitPrice: string) {
    super(
      'AMOUNT_BELOW_UNIT_PRICE',
      `El monto $${amount} no alcanza para una unidad a $${unitPrice}`,
      { amount, unitPrice },
    );
  }
}

export class IdempotencyKeyReuseError extends BusinessRuleError {
  constructor(orderId: number) {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'Esa Idempotency-Key ya se usó para una orden distinta; generá una key nueva',
      { orderId },
    );
  }
}

export class OrderNotFoundError extends NotFoundError {
  constructor(orderId: number, userId: number) {
    super('ORDER_NOT_FOUND', `El usuario ${userId} no tiene una orden ${orderId}`, {
      orderId,
      userId,
    });
  }
}

export class OrderNotCancellableError extends ConflictError {
  constructor(orderId: number, status: OrderStatus) {
    super(
      'ORDER_NOT_CANCELLABLE',
      `La orden ${orderId} está en estado ${status}; solo se cancelan órdenes en estado NEW`,
      { orderId, status },
    );
  }
}
