import type { Queryable } from '../../shared/db.ts';
import { parseCents } from '../../shared/money.ts';
import {
  CASH_TICKER,
  CASH_TYPE,
  type Instrument,
  type Quote,
  type QuotedInstrument,
} from './domain/instrument.ts';
import type { InstrumentCatalog } from './ports.ts';

interface InstrumentRow {
  id: number;
  ticker: string;
  name: string;
  type: string;
}

interface QuotedInstrumentRow extends InstrumentRow {
  close: string | null;
  previousclose: string | null;
  date: string | null;
}

const LATEST_QUOTE = `
  LEFT JOIN LATERAL (
    SELECT m.close, m.previousclose, m.date::text AS date
    FROM marketdata m
    WHERE m.instrumentid = i.id AND m.close IS NOT NULL
    ORDER BY m.date DESC
    LIMIT 1
  ) q ON true`;

/**
 * En LIKE, `%` y `_` son comodines. Si el usuario los escribe, busca esos caracteres:
 * sin escaparlos, buscar "%" devolvería todo el mercado.
 */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

export class PgInstrumentRepository implements InstrumentCatalog {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async findById(instrumentId: number): Promise<Instrument | null> {
    const { rows } = await this.db.query<InstrumentRow>(
      'SELECT id, ticker, name, type FROM instruments WHERE id = $1',
      [instrumentId],
    );
    return rows[0] ?? null;
  }

  async findCash(): Promise<Instrument | null> {
    const { rows } = await this.db.query<InstrumentRow>(
      'SELECT id, ticker, name, type FROM instruments WHERE ticker = $1 AND type = $2',
      [CASH_TICKER, CASH_TYPE],
    );
    return rows[0] ?? null;
  }

  async findWithQuotes(instrumentIds: number[]): Promise<QuotedInstrument[]> {
    if (instrumentIds.length === 0) return [];
    const { rows } = await this.db.query<QuotedInstrumentRow>(
      `SELECT i.id, i.ticker, i.name, i.type, q.close, q.previousclose, q.date
       FROM instruments i ${LATEST_QUOTE}
       WHERE i.id = ANY($1::int[])`,
      [instrumentIds],
    );
    return rows.map(toQuotedInstrument);
  }

  async search(text: string, limit: number): Promise<QuotedInstrument[]> {
    const escaped = escapeLikePattern(text);
    const { rows } = await this.db.query<QuotedInstrumentRow>(
      `SELECT i.id, i.ticker, i.name, i.type, q.close, q.previousclose, q.date
       FROM instruments i ${LATEST_QUOTE}
       WHERE i.type <> $1
         AND (i.ticker ILIKE $2 OR i.name ILIKE $2)
       ORDER BY (upper(i.ticker) = upper($3)) DESC, (i.ticker ILIKE $4) DESC, i.ticker
       LIMIT $5`,
      [CASH_TYPE, `%${escaped}%`, text, `${escaped}%`, limit],
    );
    return rows.map(toQuotedInstrument);
  }
}

function toQuote(row: QuotedInstrumentRow): Quote | null {
  if (row.close === null || row.date === null) return null;
  return {
    close: parseCents(row.close),
    previousClose: row.previousclose === null ? null : parseCents(row.previousclose),
    date: row.date,
  };
}

function toQuotedInstrument(row: QuotedInstrumentRow): QuotedInstrument {
  return { id: row.id, ticker: row.ticker, name: row.name, type: row.type, quote: toQuote(row) };
}
