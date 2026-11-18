import type { Queryable } from '../../shared/db.ts';

export interface BalanceMismatch {
  userId: number;
  instrumentId: number;
  expectedAvailable: string;
  actualAvailable: string;
  expectedReserved: string;
  actualReserved: string;
}

/** Recalcula cada saldo desde `orders` y lo compara con `balances`; devuelve solo las diferencias. */
const MISMATCHES_SQL = `
    WITH cash AS (
      SELECT id FROM instruments WHERE ticker = 'ARS' AND type = 'MONEDA'
    ),
    ledger AS (
      SELECT
        o.userid,
        (SELECT id FROM cash) AS instrumentid,
        SUM(CASE
              WHEN o.status = 'FILLED' AND o.side IN ('CASH_IN', 'SELL') THEN o.size * o.price
              WHEN o.status = 'FILLED' AND o.side IN ('CASH_OUT', 'BUY') THEN -(o.size * o.price)
              ELSE 0
            END) AS total,
        SUM(CASE WHEN o.status = 'NEW' AND o.side = 'BUY' THEN o.size * o.price ELSE 0 END) AS reserved
      FROM orders o
      WHERE o.status IN ('FILLED', 'NEW')
      GROUP BY o.userid

      UNION ALL

      SELECT
        o.userid,
        o.instrumentid,
        SUM(CASE
              WHEN o.status = 'FILLED' AND o.side = 'BUY'  THEN o.size
              WHEN o.status = 'FILLED' AND o.side = 'SELL' THEN -o.size
              ELSE 0
            END) AS total,
        SUM(CASE WHEN o.status = 'NEW' AND o.side = 'SELL' THEN o.size ELSE 0 END) AS reserved
      FROM orders o
      WHERE o.side IN ('BUY', 'SELL') AND o.status IN ('FILLED', 'NEW')
      GROUP BY o.userid, o.instrumentid
    ),
    compared AS (
      SELECT
        COALESCE(l.userid, b.userid)             AS userid,
        COALESCE(l.instrumentid, b.instrumentid) AS instrumentid,
        COALESCE(l.total - l.reserved, 0)        AS expected_available,
        COALESCE(b.available, 0)                 AS actual_available,
        COALESCE(l.reserved, 0)                  AS expected_reserved,
        COALESCE(b.reserved, 0)                  AS actual_reserved
      FROM ledger l
      FULL OUTER JOIN balances b
        ON b.userid = l.userid AND b.instrumentid = l.instrumentid
    )
    SELECT
      userid,
      instrumentid,
      expected_available::text,
      actual_available::text,
      expected_reserved::text,
      actual_reserved::text
    FROM compared
    WHERE expected_available <> actual_available OR expected_reserved <> actual_reserved
    ORDER BY userid, instrumentid`;

interface MismatchRow {
  userid: number;
  instrumentid: number;
  expected_available: string;
  actual_available: string;
  expected_reserved: string;
  actual_reserved: string;
}

/**
 * Compara `balances` contra lo que se obtiene recalculando todo desde `orders`.
 *
 * `orders` es la fuente de verdad y `balances` una proyección que se mantiene en la misma
 * transacción que cada orden: en un sistema sano esta consulta no devuelve filas. La usan
 * `npm run reconcile` y los tests, como invariante.
 */
export async function findBalanceMismatches(db: Queryable): Promise<BalanceMismatch[]> {
  const { rows } = await db.query<MismatchRow>(MISMATCHES_SQL);
  return rows.map((row) => ({
    userId: row.userid,
    instrumentId: row.instrumentid,
    expectedAvailable: row.expected_available,
    actualAvailable: row.actual_available,
    expectedReserved: row.expected_reserved,
    actualReserved: row.actual_reserved,
  }));
}
