import type {
  Instrument,
  QuotedInstrument,
} from '../../src/modules/instruments/domain/instrument.ts';
import type { InstrumentCatalog } from '../../src/modules/instruments/ports.ts';
import type { MarketPrices } from '../../src/modules/market/ports.ts';
import type { Order, OrderStatus } from '../../src/modules/orders/domain/order.ts';
import type { AssetAmount } from '../../src/modules/orders/domain/order-legs.ts';
import {
  type BalanceStore,
  DuplicateIdempotencyKeyError,
  type NewOrder,
  type OrderStore,
  type OrderWithRequestHash,
  type OrderWriteContext,
} from '../../src/modules/orders/ports.ts';
import type { UserDirectory } from '../../src/modules/users/ports.ts';
import { InvariantViolationError } from '../../src/shared/errors.ts';
import type { Logger } from '../../src/shared/logger.ts';
import { type Cents, formatCents, parseSignedCents } from '../../src/shared/money.ts';
import type { UnitOfWork } from '../../src/shared/unit-of-work.ts';

/**
 * Dobles en memoria de los puertos, para probar los casos de uso sin base de datos.
 * Respetan el contrato de cada puerto: operaciones atómicas, key única por usuario y
 * unidad de trabajo que deshace todo si algo falla.
 */

export interface LogEntry {
  level: 'info' | 'warn';
  fields: Record<string, unknown>;
  message: string | undefined;
}

export class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(fields: object, message?: string): void {
    this.entries.push({ level: 'info', fields: { ...fields }, message });
  }

  warn(fields: object, message?: string): void {
    this.entries.push({ level: 'warn', fields: { ...fields }, message });
  }

  events(): unknown[] {
    return this.entries.map((entry) => entry.fields.event);
  }
}

interface Balance {
  available: bigint;
  reserved: bigint;
}

interface StoredOrder {
  order: Order;
  idempotencyKey: string;
  requestHash: string;
}

interface BookState {
  orders: StoredOrder[];
  balances: Map<string, Balance>;
}

const amountOf = (asset: AssetAmount): bigint => parseSignedCents(asset.amount);

/** Órdenes y saldos en memoria. Es a la vez almacén de órdenes, de saldos y unidad de trabajo. */
export class InMemoryOrderBook implements OrderStore, BalanceStore, UnitOfWork<OrderWriteContext> {
  private state: BookState = { orders: [], balances: new Map() };
  private nextId = 1;
  /** Cuántas unidades de trabajo se abrieron: sirve para comprobar que algo no escribió. */
  unitsOfWork = 0;
  /** Permite simular una falla al grabar la orden. */
  failNextInsertWith: Error | null = null;

  // ── UnitOfWork ────────────────────────────────────────────────────────────

  async run<T>(work: (context: OrderWriteContext) => Promise<T>): Promise<T> {
    this.unitsOfWork++;
    const before = this.snapshot();
    try {
      return await work({ orders: this, balances: this });
    } catch (error) {
      this.state = before; // rollback: nada de lo hecho en esta unidad de trabajo queda
      throw error;
    }
  }

  private snapshot(): BookState {
    return {
      orders: this.state.orders.map((stored) => ({ ...stored, order: { ...stored.order } })),
      balances: new Map([...this.state.balances].map(([key, value]) => [key, { ...value }])),
    };
  }

  // ── OrderStore ────────────────────────────────────────────────────────────

  async insert(newOrder: NewOrder): Promise<Order> {
    if (this.failNextInsertWith) {
      const error = this.failNextInsertWith;
      this.failNextInsertWith = null;
      throw error;
    }
    const duplicated = this.state.orders.some(
      (stored) =>
        stored.order.userId === newOrder.userId &&
        stored.idempotencyKey === newOrder.idempotencyKey,
    );
    if (duplicated) throw new DuplicateIdempotencyKeyError();

    const order: Order = {
      id: this.nextId++,
      userId: newOrder.userId,
      instrumentId: newOrder.instrumentId,
      side: newOrder.side,
      type: newOrder.type,
      status: newOrder.status,
      size: newOrder.size,
      price: newOrder.price,
      rejectionReason: newOrder.rejectionReason,
      datetime: new Date('2026-01-01T00:00:00Z'),
    };
    this.state.orders.push({
      order,
      idempotencyKey: newOrder.idempotencyKey,
      requestHash: newOrder.requestHash,
    });
    return { ...order };
  }

  async findByIdempotencyKey(
    userId: number,
    idempotencyKey: string,
  ): Promise<OrderWithRequestHash | null> {
    const stored = this.state.orders.find(
      (candidate) =>
        candidate.order.userId === userId && candidate.idempotencyKey === idempotencyKey,
    );
    return stored ? { order: { ...stored.order }, requestHash: stored.requestHash } : null;
  }

  async findById(orderId: number, userId: number): Promise<Order | null> {
    const stored = this.find(orderId, userId);
    return stored ? { ...stored.order } : null;
  }

  async transition(
    orderId: number,
    userId: number,
    to: OrderStatus,
    allowedFrom: readonly OrderStatus[],
  ): Promise<Order | null> {
    const stored = this.find(orderId, userId);
    if (!stored || !allowedFrom.includes(stored.order.status)) return null;
    stored.order.status = to;
    return { ...stored.order };
  }

  private find(orderId: number, userId: number): StoredOrder | undefined {
    return this.state.orders.find(
      (stored) => stored.order.id === orderId && stored.order.userId === userId,
    );
  }

  // ── BalanceStore ──────────────────────────────────────────────────────────

  async reserve(userId: number, asset: AssetAmount): Promise<boolean> {
    const balance = this.balance(userId, asset.instrumentId);
    if (balance.available < amountOf(asset)) return false;
    balance.available -= amountOf(asset);
    balance.reserved += amountOf(asset);
    return true;
  }

  async release(userId: number, asset: AssetAmount): Promise<void> {
    const balance = this.balance(userId, asset.instrumentId);
    if (balance.reserved < amountOf(asset)) {
      throw new InvariantViolationError(`No hay ${asset.amount} reservado`);
    }
    balance.reserved -= amountOf(asset);
    balance.available += amountOf(asset);
  }

  async exchange(userId: number, debit: AssetAmount, credit: AssetAmount): Promise<boolean> {
    const from = this.balance(userId, debit.instrumentId);
    if (from.available < amountOf(debit)) return false;
    from.available -= amountOf(debit);
    this.balance(userId, credit.instrumentId).available += amountOf(credit);
    return true;
  }

  private balance(userId: number, instrumentId: number): Balance {
    const key = `${userId}:${instrumentId}`;
    let balance = this.state.balances.get(key);
    if (!balance) {
      balance = { available: 0n, reserved: 0n };
      this.state.balances.set(key, balance);
    }
    return balance;
  }

  // ── Ayudas para los tests ─────────────────────────────────────────────────

  /** Fija el saldo de un activo. Los importes van como decimal ("1000", "925.85"). */
  give(userId: number, instrumentId: number, available: string, reserved = '0'): void {
    const balance = this.balance(userId, instrumentId);
    balance.available = parseSignedCents(available);
    balance.reserved = parseSignedCents(reserved);
  }

  balanceOf(userId: number, instrumentId: number): { available: string; reserved: string } {
    const balance = this.balance(userId, instrumentId);
    return { available: formatCents(balance.available), reserved: formatCents(balance.reserved) };
  }

  allOrders(): Order[] {
    return this.state.orders.map((stored) => ({ ...stored.order }));
  }
}

export class InMemoryUsers implements UserDirectory {
  private readonly ids: Set<number>;

  constructor(ids: number[]) {
    this.ids = new Set(ids);
  }

  async exists(userId: number): Promise<boolean> {
    return this.ids.has(userId);
  }
}

export class InMemoryInstruments implements InstrumentCatalog {
  private readonly instruments: QuotedInstrument[];
  readonly searches: Array<{ text: string; limit: number }> = [];

  constructor(instruments: QuotedInstrument[]) {
    this.instruments = instruments;
  }

  async findById(instrumentId: number): Promise<Instrument | null> {
    return this.instruments.find((instrument) => instrument.id === instrumentId) ?? null;
  }

  async findCash(): Promise<Instrument | null> {
    return this.instruments.find((instrument) => instrument.type === 'MONEDA') ?? null;
  }

  async findWithQuotes(instrumentIds: number[]): Promise<QuotedInstrument[]> {
    return this.instruments.filter((instrument) => instrumentIds.includes(instrument.id));
  }

  async search(text: string, limit: number): Promise<QuotedInstrument[]> {
    this.searches.push({ text, limit });
    return this.instruments
      .filter((instrument) => instrument.ticker.toLowerCase().includes(text.toLowerCase()))
      .slice(0, limit);
  }
}

export class InMemoryMarketPrices implements MarketPrices {
  private readonly closes: Map<number, Cents>;
  /** Cuántas veces se consultó el precio: una LIMIT no debería consultarlo. */
  lookups = 0;

  constructor(closes: Record<number, Cents>) {
    this.closes = new Map(Object.entries(closes).map(([id, close]) => [Number(id), close]));
  }

  async latestClose(instrumentId: number): Promise<Cents | null> {
    this.lookups++;
    return this.closes.get(instrumentId) ?? null;
  }
}
