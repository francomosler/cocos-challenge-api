import type { Queryable } from '../../shared/db.ts';
import { parseCents, parseSignedCents } from '../../shared/money.ts';
import type { Trade } from './domain/portfolio-calculator.ts';
import type { CashSummary, PortfolioLedger } from './ports.ts';

/**
 * Lecturas del portfolio. Todo sale de `orders`, como pide el enunciado: la tabla
 * `balances` solo se usa para autorizar órdenes, no para informar.
 */
export class PgPortfolioRepository implements PortfolioLedger {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async cashSummary(userId: number): Promise<CashSummary> {
    const { rows } = await this.db.query<{ total: string; reserved: string }>(
      `SELECT
         COALESCE(SUM(CASE
           WHEN status = 'FILLED' AND side IN ('CASH_IN', 'SELL') THEN size * price
           WHEN status = 'FILLED' AND side IN ('CASH_OUT', 'BUY') THEN -(size * price)
         END), 0)::text AS total,
         COALESCE(SUM(CASE
           WHEN status = 'NEW' AND side = 'BUY' THEN size * price
         END), 0)::text AS reserved
       FROM orders
       WHERE userid = $1 AND status IN ('FILLED', 'NEW')`,
      [userId],
    );
    const row = rows[0];
    return {
      total: parseSignedCents(row?.total ?? '0'),
      reserved: parseCents(row?.reserved ?? '0'),
    };
  }

  async filledTrades(userId: number): Promise<Trade[]> {
    const { rows } = await this.db.query<{
      instrumentid: number;
      side: 'BUY' | 'SELL';
      size: number;
      price: string;
    }>(
      `SELECT instrumentid, side, size, price
       FROM orders
       WHERE userid = $1 AND status = 'FILLED' AND side IN ('BUY', 'SELL')
       ORDER BY datetime, id`,
      [userId],
    );
    return rows.map((row) => ({
      instrumentId: row.instrumentid,
      side: row.side,
      size: row.size,
      price: parseCents(row.price),
    }));
  }

  async reservedShares(userId: number): Promise<Map<number, number>> {
    const { rows } = await this.db.query<{ instrumentid: number; reserved: string }>(
      `SELECT instrumentid, SUM(size)::text AS reserved
       FROM orders
       WHERE userid = $1 AND status = 'NEW' AND side = 'SELL'
       GROUP BY instrumentid`,
      [userId],
    );
    return new Map(rows.map((row) => [row.instrumentid, Number(row.reserved)]));
  }
}
