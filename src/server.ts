import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './shared/db.ts';

const config = loadConfig();
const pool = createPool(config.db);
const app = await buildApp({ config, pool });

/**
 * Apagado ordenado: se dejan de aceptar pedidos, se espera a los que están en curso y
 * recién ahí se cierran las conexiones a la base. Ninguna orden queda a medio procesar.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ event: 'server.stopping', signal }, 'Apagando');
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (error) {
    app.log.error({ event: 'server.stop_failed', err: error }, 'Falló el apagado ordenado');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error({ event: 'server.start_failed', err: error }, 'No se pudo iniciar el servidor');
  await pool.end();
  process.exit(1);
}
