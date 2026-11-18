import { type Queryable, sqlState } from '../../shared/db.ts';
import { formatCents, parseCents } from '../../shared/money.ts';
import type { Order, OrderSide, OrderStatus, OrderType, RejectionReason } from './domain/order.ts';
import {
  DuplicateIdempotencyKeyError,
  type NewOrder,
  type OrderStore,
  type OrderWithRequestHash,
} from './ports.ts';

const UNIQUE_VIOLATION = '23505';
const IDEMPOTENCY_INDEX = 'orders_user_idempotency_key_idx';

interface OrderRow {
  id: number;
  instrumentid: number;
  userid: number;
  size: number;
  price: string;
  type: OrderType;
  side: OrderSide;
  status: OrderStatus;
  datetime: Date;
  rejection_reason: RejectionReason | null;
  request_hash: string | null;
}

const COLUMNS =
  'id, instrumentid, userid, size, price, type, side, status, datetime, rejection_reason, request_hash';

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    userId: row.userid,
    instrumentId: row.instrumentid,
    side: row.side,
    type: row.type,
    status: row.status,
    size: row.size,
    price: parseCents(row.price),
    rejectionReason: row.rejection_reason,
    datetime: row.datetime,
  };
}

function isIdempotencyConflict(error: unknown): boolean {
  return (
    sqlState(error) === UNIQUE_VIOLATION &&
    (error as { constraint?: string }).constraint === IDEMPOTENCY_INDEX
  );
}

export class PgOrderRepository implements OrderStore {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  /** La unicidad de la key la garantiza el índice único `(userid, idempotency_key)`. */
  async insert(order: NewOrder): Promise<Order> {
    try {
      const { rows } = await this.db.query<OrderRow>(
        `INSERT INTO orders
           (instrumentid, userid, size, price, type, side, status, datetime,
            rejection_reason, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, now() AT TIME ZONE 'UTC', $8, $9, $10)
         RETURNING ${COLUMNS}`,
        insertValues(order),
      );
      return toOrder(rows[0] as OrderRow);
    } catch (error) {
      if (isIdempotencyConflict(error)) throw new DuplicateIdempotencyKeyError();
      throw error;
    }
  }

  async findByIdempotencyKey(
    userId: number,
    idempotencyKey: string,
  ): Promise<OrderWithRequestHash | null> {
    const { rows } = await this.db.query<OrderRow>(
      `SELECT ${COLUMNS} FROM orders WHERE userid = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    const row = rows[0];
    return row ? { order: toOrder(row), requestHash: row.request_hash?.trim() ?? null } : null;
  }

  async findById(orderId: number, userId: number): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `SELECT ${COLUMNS} FROM orders WHERE id = $1 AND userid = $2`,
      [orderId, userId],
    );
    const row = rows[0];
    return row ? toOrder(row) : null;
  }

  /**
   * Un único UPDATE con el estado esperado en el WHERE. Si varios pedidos llegan juntos,
   * esperan el lock de la fila y al reevaluar la condición solo el primero la cumple.
   */
  async transition(
    orderId: number,
    userId: number,
    to: OrderStatus,
    allowedFrom: readonly OrderStatus[],
  ): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `UPDATE orders
       SET status = $3
       WHERE id = $1 AND userid = $2 AND status = ANY($4::text[])
       RETURNING ${COLUMNS}`,
      [orderId, userId, to, [...allowedFrom]],
    );
    const row = rows[0];
    return row ? toOrder(row) : null;
  }
}

function insertValues(order: NewOrder): unknown[] {
  return [
    order.instrumentId,
    order.userId,
    order.size,
    formatCents(order.price),
    order.type,
    order.side,
    order.status,
    order.rejectionReason,
    order.idempotencyKey,
    order.requestHash,
  ];
}
