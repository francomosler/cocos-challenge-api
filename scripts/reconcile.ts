import { loadConfig } from '../src/config.ts';
import { findBalanceMismatches } from '../src/modules/orders/balance-reconciliation.repository.ts';
import { createPool } from '../src/shared/db.ts';

/** Verifica que `balances` coincida con lo que dicen las órdenes. Sale con 1 si no. */
const pool = createPool(loadConfig().db);

try {
  const mismatches = await findBalanceMismatches(pool);
  if (mismatches.length === 0) {
    console.log('OK: balances coincide con el recálculo desde orders.');
  } else {
    console.error(`Se encontraron ${mismatches.length} diferencias:`);
    console.table(mismatches);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
