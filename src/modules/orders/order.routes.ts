import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ErrorResponse } from '../../shared/http-schemas.ts';
import type { CancelOrder } from './cancel-order.ts';
import { presentOrder, toPlaceOrderCommand } from './order.mappers.ts';
import {
  CancelOrderParams,
  IdempotencyHeaders,
  OrderResponse,
  PlaceOrderBody,
  PlaceOrderParams,
  ReplayedOrderResponse,
} from './order.schemas.ts';
import type { PlaceOrder } from './place-order.ts';

/** La instancia de Fastify que recibe un plugin, ya tipada con TypeBox. */
type App = Parameters<FastifyPluginAsyncTypebox>[0];

const placeOrderSchema = {
  tags: ['Órdenes'],
  summary: 'Enviar una orden de compra o venta',
  description:
    'MARKET se ejecuta al último precio y queda FILLED. LIMIT queda NEW y reserva el saldo que compromete. Si el saldo no alcanza, la orden se registra igual, en estado REJECTED.',
  params: PlaceOrderParams,
  headers: IdempotencyHeaders,
  body: PlaceOrderBody,
  response: {
    201: OrderResponse,
    200: ReplayedOrderResponse,
    400: ErrorResponse,
    404: ErrorResponse,
    422: ErrorResponse,
    429: ErrorResponse,
    503: ErrorResponse,
  },
};

const cancelOrderSchema = {
  tags: ['Órdenes'],
  summary: 'Cancelar una orden en estado NEW',
  description:
    'Libera el saldo que la orden tenía reservado. Repetir la cancelación devuelve la misma orden ya cancelada.',
  params: CancelOrderParams,
  response: {
    200: OrderResponse,
    400: ErrorResponse,
    404: ErrorResponse,
    409: ErrorResponse,
    429: ErrorResponse,
    503: ErrorResponse,
  },
};

/**
 * Las rutas piden solo `execute`: les da igual si reciben el caso de uso o una envoltura
 * suya (ver el control de admisión en `app.ts`).
 */
export interface OrderRoutesDependencies {
  placeOrder: Pick<PlaceOrder, 'execute'>;
  cancelOrder: Pick<CancelOrder, 'execute'>;
}

function registerPlaceOrder(app: App, placeOrder: OrderRoutesDependencies['placeOrder']): void {
  app.post('/users/:userId/orders', { schema: placeOrderSchema }, async (request, reply) => {
    const command = toPlaceOrderCommand(
      request.params.userId,
      request.headers['idempotency-key'],
      request.body,
    );
    const { order, replayed } = await placeOrder.execute(command, request.log);
    if (replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.code(replayed ? 200 : 201).send(presentOrder(order));
  });
}

function registerCancelOrder(app: App, cancelOrder: OrderRoutesDependencies['cancelOrder']): void {
  app.post(
    '/users/:userId/orders/:orderId/cancel',
    { schema: cancelOrderSchema },
    async (request) => {
      const { order } = await cancelOrder.execute(request.params, request.log);
      return presentOrder(order);
    },
  );
}

export function orderRoutes(deps: OrderRoutesDependencies): FastifyPluginAsyncTypebox {
  return async (app) => {
    registerPlaceOrder(app, deps.placeOrder);
    registerCancelOrder(app, deps.cancelOrder);
  };
}
