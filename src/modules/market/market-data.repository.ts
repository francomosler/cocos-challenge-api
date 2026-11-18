import type { Queryable } from '../../shared/db.ts';
import { type Cents, parseCents } from '../../shared/money.ts';
import type { MarketPrices } from './ports.ts';

export class PgMarketDataRepository implements MarketPrices {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async latestClose(instrumentId: number): Promise<Cents | null> {
    const { rows } = await this.db.query<{ close: string }>(
      `SELECT close
       FROM marketdata
       WHERE instrumentid = $1 AND close IS NOT NULL
       ORDER BY date DESC
       LIMIT 1`,
      [instrumentId],
    );
    const row = rows[0];
    return row ? parseCents(row.close) : null;
  }
}
