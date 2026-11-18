import { createHash } from 'node:crypto';
import {
  InstrumentNotFoundError,
  InvariantViolationError,
  UserNotFoundError,
} from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';
import { type Cents, formatCents } from '../../shared/money.ts';
import type { UnitOfWork } from '../../shared/unit-of-work.ts';
import { type Instrument, isTradable } from '../instruments/domain/instrument.ts';
import type { InstrumentCatalog } from '../instruments/ports.ts';
import type { MarketPrices } from '../market/ports.ts';
import type { UserDirectory } from '../users/ports.ts';
import type { Order, OrderType, TradeSide } from './domain/order.ts';
import { IdempotencyKeyReuseError, InstrumentNotTradableError } from './domain/order-errors.ts';
import { legsFor, type OrderLegs } from './domain/order-legs.ts';
import { quantityFrom, resolveSize } from './domain/order-sizing.ts';
import { type OrderTypeStrategy, strategyFor } from './domain/order-type.ts';
import {
  type BalanceStore,
  DuplicateIdempotencyKeyError,
  type OrderStore,
  type OrderWithRequestHash,
  type OrderWriteContext,
} from './ports.ts';

export interface PlaceOrderCommand {
  userId: number;
  /** Identifica la intención de operar: reintentar con la misma key no crea otra orden. */
  idempotencyKey: string;
  instrumentId: number;
  side: TradeSide;
  type: OrderType;
  size?: number;
  amount?: Cents;
  price?: Cents;
}

export interface PlaceOrderResult {
  order: Order;
  /** `true` si la orden ya existía y se devolvió la original sin operar de nuevo. */
  replayed: boolean;
}

export interface PlaceOrderDependencies {
  users: UserDirectory;
  instruments: Pick<InstrumentCatalog, 'findById'>;
  marketPrices: MarketPrices;
  /** Lectura suelta de órdenes, fuera de la unidad de trabajo. */
  orders: Pick<OrderStore, 'findByIdempotencyKey'>;
  /** Escrituras: el saldo y la orden se confirman juntos o no se confirman. */
  unitOfWork: UnitOfWork<OrderWriteContext>;
  cashInstrumentId: number;
}

/** Huella del pedido: misma key con otra huella es un error del cliente, no un reintento. */
export function hashOrderRequest(command: PlaceOrderCommand): string {
  const canonical = JSON.stringify([
    command.instrumentId,
    command.side,
    command.type,
    command.size ?? null,
    command.amount?.toString() ?? null,
    command.price?.toString() ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Orden ya valuada: se sabe cuánto es y qué entrega y recibe, falta ver si alcanza. */
interface PricedOrder {
  strategy: OrderTypeStrategy;
  instrumentId: number;
  size: number;
  price: Cents;
  legs: OrderLegs;
}

export class PlaceOrder {
  private readonly deps: PlaceOrderDependencies;

  constructor(deps: PlaceOrderDependencies) {
    this.deps = deps;
  }

  async execute(command: PlaceOrderCommand, log: Logger): Promise<PlaceOrderResult> {
    const requestHash = hashOrderRequest(command);

    const previous = await this.findPrevious(command);
    if (previous) return this.replay(previous, requestHash, log);

    // Todo lo de acá hasta `settleAndRecord` son lecturas sin locks: no frenan a ningún
    // otro pedido, ni de esta cuenta ni de otra.
    const priced = await this.price(command);

    try {
      const order = await this.settleAndRecord(command, priced, requestHash);
      logOutcome(log, order);
      return { order, replayed: false };
    } catch (error) {
      if (!(error instanceof DuplicateIdempotencyKeyError)) throw error;
      return this.replayWinner(command, requestHash, log);
    }
  }

  private findPrevious(command: PlaceOrderCommand): Promise<OrderWithRequestHash | null> {
    return this.deps.orders.findByIdempotencyKey(command.userId, command.idempotencyKey);
  }

  private replay(
    previous: OrderWithRequestHash,
    requestHash: string,
    log: Logger,
  ): PlaceOrderResult {
    if (previous.requestHash !== requestHash) {
      throw new IdempotencyKeyReuseError(previous.order.id);
    }
    log.info(
      { event: 'order.replayed', orderId: previous.order.id, userId: previous.order.userId },
      'Pedido repetido: se devuelve la orden original',
    );
    return { order: previous.order, replayed: true };
  }

  /**
   * Otro pedido con la misma key confirmó primero. La unidad de trabajo de este se deshizo
   * entera (incluida su reserva), así que se devuelve la orden ganadora.
   */
  private async replayWinner(
    command: PlaceOrderCommand,
    requestHash: string,
    log: Logger,
  ): Promise<PlaceOrderResult> {
    const winner = await this.findPrevious(command);
    if (!winner) throw new InvariantViolationError('Key duplicada sin orden asociada');
    return this.replay(winner, requestHash, log);
  }

  /** Valida el pedido y calcula precio, cantidad y activos involucrados. No escribe nada. */
  private async price(command: PlaceOrderCommand): Promise<PricedOrder> {
    const strategy = strategyFor(command.type);
    const quantity = quantityFrom(command);
    const instrument = await this.findTradableInstrument(command);

    const price = strategy.resolvePrice({
      instrumentId: instrument.id,
      requestedPrice: command.price ?? null,
      lastClose: strategy.needsMarketPrice
        ? await this.deps.marketPrices.latestClose(instrument.id)
        : null,
    });
    const size = resolveSize(quantity, price);
    const legs = legsFor(
      { side: command.side, instrumentId: instrument.id, size, price },
      this.deps.cashInstrumentId,
    );
    return { strategy, instrumentId: instrument.id, size, price, legs };
  }

  private async findTradableInstrument(command: PlaceOrderCommand): Promise<Instrument> {
    const [userExists, instrument] = await Promise.all([
      this.deps.users.exists(command.userId),
      this.deps.instruments.findById(command.instrumentId),
    ]);
    if (!userExists) throw new UserNotFoundError(command.userId);
    if (!instrument) throw new InstrumentNotFoundError(command.instrumentId);
    if (!isTradable(instrument)) {
      throw new InstrumentNotTradableError(instrument.id, instrument.ticker);
    }
    return instrument;
  }

  /**
   * Única parte que escribe: mueve o reserva el saldo y graba la orden, todo junto.
   * Si el saldo no alcanza no se mueve nada y la orden queda grabada como REJECTED.
   */
  private settleAndRecord(
    command: PlaceOrderCommand,
    priced: PricedOrder,
    requestHash: string,
  ): Promise<Order> {
    return this.deps.unitOfWork.run(async ({ orders, balances }) => {
      const covered = await settle(balances, command.userId, priced);
      return orders.insert({
        userId: command.userId,
        instrumentId: priced.instrumentId,
        side: command.side,
        type: command.type,
        status: covered ? priced.strategy.acceptedStatus : 'REJECTED',
        size: priced.size,
        price: priced.price,
        rejectionReason: covered ? null : priced.legs.shortfall,
        idempotencyKey: command.idempotencyKey,
        requestHash,
      });
    });
  }
}

/** Mueve o aparta el saldo según cómo liquida el tipo de orden. Devuelve si alcanzó. */
function settle(balances: BalanceStore, userId: number, priced: PricedOrder): Promise<boolean> {
  const { strategy, legs } = priced;
  return strategy.settlement === 'RESERVE'
    ? balances.reserve(userId, legs.debit)
    : balances.exchange(userId, legs.debit, legs.credit);
}

function logOutcome(log: Logger, order: Order): void {
  const fields = {
    orderId: order.id,
    userId: order.userId,
    instrumentId: order.instrumentId,
    side: order.side,
    type: order.type,
    status: order.status,
    size: order.size,
    price: formatCents(order.price),
  };
  if (order.status === 'REJECTED') {
    log.warn(
      { event: 'order.rejected', reason: order.rejectionReason, ...fields },
      'Orden rechazada',
    );
  } else {
    log.info({ event: 'order.placed', ...fields }, 'Orden registrada');
  }
}
