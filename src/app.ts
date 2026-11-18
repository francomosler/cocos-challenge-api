import { randomUUID } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import type pg from 'pg';
import type { Config } from './config.ts';
import { PgInstrumentRepository } from './modules/instruments/instrument.repository.ts';
import { instrumentRoutes } from './modules/instruments/instrument.routes.ts';
import { SearchInstruments } from './modules/instruments/search-instruments.ts';
import { PgMarketDataRepository } from './modules/market/market-data.repository.ts';
import { PgBalanceRepository } from './modules/orders/balance.repository.ts';
import { CancelOrder } from './modules/orders/cancel-order.ts';
import { PgOrderRepository } from './modules/orders/order.repository.ts';
import { orderRoutes } from './modules/orders/order.routes.ts';
import { PlaceOrder } from './modules/orders/place-order.ts';
import type { OrderWriteContext } from './modules/orders/ports.ts';
import { GetPortfolio } from './modules/portfolio/get-portfolio.ts';
import { PgPortfolioRepository } from './modules/portfolio/portfolio.repository.ts';
import { portfolioRoutes } from './modules/portfolio/portfolio.routes.ts';
import type { PortfolioReadContext } from './modules/portfolio/ports.ts';
import { PgUserRepository } from './modules/users/user.repository.ts';
import { registerErrorHandler } from './plugins/error-handler.ts';
import { healthRoutes } from './plugins/health.ts';
import { registerSwagger } from './plugins/swagger.ts';
import { registerValidation } from './plugins/validation.ts';
import { Admission } from './shared/admission.ts';
import { Database } from './shared/db.ts';

/** Destino de las líneas de log. Por defecto, la salida estándar. */
export interface LogStream {
  write(line: string): void;
}

export interface AppOptions {
  config: Config;
  /** El pool lo crea y lo cierra quien arranca la app (`server.ts` o un test). */
  pool: pg.Pool;
  logStream?: LogStream;
  /** Control de admisión de la instancia. Por defecto se arma con los límites de `config`. */
  admission?: Admission;
}

/** Lo que las rutas necesitan de cada caso de uso. */
interface UseCases {
  searchInstruments: Pick<SearchInstruments, 'execute'>;
  getPortfolio: Pick<GetPortfolio, 'execute'>;
  placeOrder: Pick<PlaceOrder, 'execute'>;
  cancelOrder: Pick<CancelOrder, 'execute'>;
}

/** Una orden pesa unos cientos de bytes; cualquier cuerpo más grande es un error o un abuso. */
const BODY_LIMIT_BYTES = 16 * 1024;

function createServer(config: Config, logStream?: LogStream) {
  const logger =
    config.logLevel === 'silent'
      ? false
      : { level: config.logLevel, ...(logStream ? { stream: logStream } : {}) };

  const app = Fastify({
    logger,
    // El BFF manda su id de pedido y queda en cada línea de log de la API.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    bodyLimit: BODY_LIMIT_BYTES,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // La API solo habla JSON: cualquier otro tipo de cuerpo se rechaza con 415.
  app.removeContentTypeParser('text/plain');
  return app;
}

/** Escrituras de órdenes: dentro de la unidad de trabajo, los almacenes quedan atados a su transacción. */
function orderWrites(database: Database, cashInstrumentId: number) {
  return database.unitOfWork<OrderWriteContext>((tx) => ({
    orders: new PgOrderRepository(tx),
    balances: new PgBalanceRepository(tx, cashInstrumentId),
  }));
}

/** Lecturas del portfolio sobre una misma foto de los datos. */
function portfolioSnapshots(database: Database) {
  return database.unitOfWork<PortfolioReadContext>(
    (tx) => ({
      users: new PgUserRepository(tx),
      ledger: new PgPortfolioRepository(tx),
      instruments: new PgInstrumentRepository(tx),
    }),
    'snapshot',
  );
}

/**
 * Raíz de composición: único lugar que conoce las implementaciones concretas.
 * Construye los adaptadores de Postgres y se los entrega a los casos de uso, que solo
 * conocen los puertos. Es inyección de dependencias a mano, sin contenedor.
 */
async function wireUseCases(database: Database): Promise<UseCases> {
  const users = new PgUserRepository(database);
  const instruments = new PgInstrumentRepository(database);
  const orders = new PgOrderRepository(database);
  const marketPrices = new PgMarketDataRepository(database);

  const cash = await instruments.findCash();
  if (!cash) throw new Error('La base no tiene el instrumento ARS de tipo MONEDA');
  const cashInstrumentId = cash.id;
  const unitOfWork = orderWrites(database, cashInstrumentId);

  return {
    searchInstruments: new SearchInstruments(instruments),
    getPortfolio: new GetPortfolio(portfolioSnapshots(database)),
    placeOrder: new PlaceOrder({
      users,
      instruments,
      marketPrices,
      orders,
      unitOfWork,
      cashInstrumentId,
    }),
    cancelOrder: new CancelOrder({ orders, unitOfWork, cashInstrumentId }),
  };
}

/**
 * Decorador: cada caso de uso pasa por el control de admisión antes de tocar la base.
 * Los pedidos de una cuenta esperan su turno; la búsqueda solo cuenta para el tope global.
 * Ni los casos de uso ni las rutas saben que existe.
 */
function withAdmission(useCases: UseCases, admission: Admission): UseCases {
  const { searchInstruments, getPortfolio, placeOrder, cancelOrder } = useCases;
  return {
    searchInstruments: {
      execute: (query, limit) => admission.run(() => searchInstruments.execute(query, limit)),
    },
    getPortfolio: {
      execute: (userId) => admission.runForAccount(userId, () => getPortfolio.execute(userId)),
    },
    placeOrder: {
      execute: (command, log) =>
        admission.runForAccount(command.userId, () => placeOrder.execute(command, log)),
    },
    cancelOrder: {
      execute: (command, log) =>
        admission.runForAccount(command.userId, () => cancelOrder.execute(command, log)),
    },
  };
}

export async function buildApp({ config, pool, logStream, admission }: AppOptions) {
  const app = createServer(config, logStream);
  registerValidation(app);
  registerErrorHandler(app);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  await registerSwagger(app);

  const database = new Database(pool);
  const useCases = withAdmission(
    await wireUseCases(database),
    admission ?? new Admission(config.admission),
  );

  await app.register(healthRoutes(() => database.query('SELECT 1')));
  await app.register(instrumentRoutes(useCases.searchInstruments));
  await app.register(portfolioRoutes(useCases.getPortfolio));
  await app.register(orderRoutes(useCases));

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
