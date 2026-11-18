import type { Queryable } from '../../shared/db.ts';
import type { UserDirectory } from './ports.ts';

export class PgUserRepository implements UserDirectory {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async exists(userId: number): Promise<boolean> {
    const { rowCount } = await this.db.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    return rowCount === 1;
  }
}
