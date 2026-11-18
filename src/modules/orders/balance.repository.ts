import type { Queryable } from '../../shared/db.ts';
import { InvariantViolationError } from '../../shared/errors.ts';
import type { AssetAmount } from './domain/order-legs.ts';
import type { BalanceStore } from './ports.ts';

/**
 * Saldos por cuenta y activo sobre la tabla `balances`.
 *
 * Toda autorización es un UPDATE condicional: "descontá si alcanza". Postgres toma el
 * lock de la fila, y si otra transacción la estaba modificando espera a que confirme y
 * reevalúa el WHERE contra el valor nuevo. Por eso dos órdenes simultáneas nunca ven el
 * mismo saldo, sin leerlo antes ni bloquear nada más que esa fila.
 *
 * Orden de locks: cuando una operación toca dos filas de la misma cuenta, primero va la
 * de pesos y después la del instrumento. Con un orden único no puede haber deadlock
 * entre una compra y una venta simultáneas del mismo activo.
 */
export class PgBalanceRepository implements BalanceStore {
  private readonly db: Queryable;
  private readonly cashInstrumentId: number;

  constructor(db: Queryable, cashInstrumentId: number) {
    this.db = db;
    this.cashInstrumentId = cashInstrumentId;
  }

  async reserve(userId: number, asset: AssetAmount): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE balances
       SET available = available - $3::numeric,
           reserved = reserved + $3::numeric,
           updated_at = now()
       WHERE userid = $1 AND instrumentid = $2 AND available >= $3::numeric`,
      [userId, asset.instrumentId, asset.amount],
    );
    return rowCount === 1;
  }

  async release(userId: number, asset: AssetAmount): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE balances
       SET available = available + $3::numeric,
           reserved = reserved - $3::numeric,
           updated_at = now()
       WHERE userid = $1 AND instrumentid = $2 AND reserved >= $3::numeric`,
      [userId, asset.instrumentId, asset.amount],
    );
    if (rowCount !== 1) {
      throw new InvariantViolationError(
        `No hay ${asset.amount} reservado del instrumento ${asset.instrumentId} para el usuario ${userId}`,
      );
    }
  }

  async exchange(userId: number, debit: AssetAmount, credit: AssetAmount): Promise<boolean> {
    // Una venta debita acciones y acredita pesos. Para respetar el orden de locks
    // (pesos primero) se toma la fila de pesos antes de tocar la del instrumento.
    if (credit.instrumentId === this.cashInstrumentId) await this.lockCash(userId);

    if (!(await this.debit(userId, debit))) return false;
    await this.credit(userId, credit);
    return true;
  }

  private async lockCash(userId: number): Promise<void> {
    await this.db.query(
      'SELECT 1 FROM balances WHERE userid = $1 AND instrumentid = $2 FOR UPDATE',
      [userId, this.cashInstrumentId],
    );
  }

  private async debit(userId: number, asset: AssetAmount): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE balances
       SET available = available - $3::numeric, updated_at = now()
       WHERE userid = $1 AND instrumentid = $2 AND available >= $3::numeric`,
      [userId, asset.instrumentId, asset.amount],
    );
    return rowCount === 1;
  }

  private async credit(userId: number, asset: AssetAmount): Promise<void> {
    await this.db.query(
      `INSERT INTO balances (userid, instrumentid, available)
       VALUES ($1, $2, $3::numeric)
       ON CONFLICT (userid, instrumentid)
       DO UPDATE SET available = balances.available + EXCLUDED.available, updated_at = now()`,
      [userId, asset.instrumentId, asset.amount],
    );
  }
}
