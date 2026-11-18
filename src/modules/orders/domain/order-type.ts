import type { Cents } from '../../../shared/money.ts';
import type { OrderType } from './order.ts';
import { InvalidOrderError, MarketPriceUnavailableError } from './order-errors.ts';

/** `orders.price` es NUMERIC(10, 2): hasta 99.999.999,99. */
export const MAX_PRICE: Cents = 9_999_999_999n;

export interface PricingContext {
  instrumentId: number;
  /** Precio enviado por el usuario, si envió alguno. */
  requestedPrice: Cents | null;
  /** Último `close` del instrumento, si la estrategia lo pidió y existe. */
  lastClose: Cents | null;
}

/**
 * Lo que cambia entre un tipo de orden y otro. El caso de uso no pregunta "¿es MARKET?":
 * le pide a la estrategia el precio, el estado inicial y cómo afecta los saldos.
 * Sumar un tipo nuevo (por ejemplo STOP) es agregar una estrategia a `STRATEGIES`.
 */
export interface OrderTypeStrategy {
  readonly type: OrderType;
  /** Si hay que consultar el último precio de mercado antes de valuar la orden. */
  readonly needsMarketPrice: boolean;
  /** Estado con el que nace la orden cuando el saldo alcanza. */
  readonly acceptedStatus: 'FILLED' | 'NEW';
  /**
   * FILL: se ejecuta ya; lo que se entrega sale de la cuenta y lo que se recibe entra.
   * RESERVE: queda pendiente; lo que se entregaría queda apartado hasta ejecutarse o cancelarse.
   */
  readonly settlement: 'FILL' | 'RESERVE';
  /** Precio por unidad al que se valúa y se registra la orden. */
  resolvePrice(context: PricingContext): Cents;
}

const marketOrder: OrderTypeStrategy = {
  type: 'MARKET',
  needsMarketPrice: true,
  acceptedStatus: 'FILLED',
  settlement: 'FILL',
  resolvePrice({ instrumentId, requestedPrice, lastClose }) {
    if (requestedPrice !== null) {
      throw new InvalidOrderError(
        'PRICE_NOT_ALLOWED',
        'Una orden MARKET no lleva "price": se ejecuta al último precio de mercado',
      );
    }
    if (lastClose === null) throw new MarketPriceUnavailableError(instrumentId);
    return lastClose;
  },
};

const limitOrder: OrderTypeStrategy = {
  type: 'LIMIT',
  needsMarketPrice: false,
  acceptedStatus: 'NEW',
  settlement: 'RESERVE',
  resolvePrice({ requestedPrice }) {
    if (requestedPrice === null) {
      throw new InvalidOrderError('PRICE_REQUIRED', 'Una orden LIMIT requiere "price"');
    }
    if (requestedPrice <= 0n || requestedPrice > MAX_PRICE) {
      throw new InvalidOrderError(
        'PRICE_OUT_OF_RANGE',
        '"price" debe ser mayor a cero y de hasta 99.999.999,99',
      );
    }
    return requestedPrice;
  },
};

const STRATEGIES: Record<OrderType, OrderTypeStrategy> = {
  MARKET: marketOrder,
  LIMIT: limitOrder,
};

export function strategyFor(type: OrderType): OrderTypeStrategy {
  return STRATEGIES[type];
}
