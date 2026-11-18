import { Type } from 'typebox';
import { IdParam, MAX_INT } from '../../shared/http-schemas.ts';
import { ORDER_STATUSES, ORDER_TYPES, TRADE_SIDES } from './domain/order.ts';

export const PlaceOrderParams = Type.Object({ userId: IdParam('Id del usuario') });

export const CancelOrderParams = Type.Object({
  userId: IdParam('Id del usuario'),
  orderId: IdParam('Id de la orden'),
});

export const IdempotencyHeaders = Type.Object({
  'idempotency-key': Type.String({
    minLength: 8,
    maxLength: 64,
    pattern: '^[A-Za-z0-9._:-]+$',
    description:
      'Identificador único de la intención de operar, generado por el cliente (por ejemplo un UUID). Reenviar el mismo pedido con la misma key devuelve la orden original en vez de crear otra.',
  }),
});

export const PlaceOrderBody = Type.Object(
  {
    instrumentId: Type.Integer({ minimum: 1, maximum: MAX_INT }),
    side: Type.Enum(TRADE_SIDES),
    type: Type.Enum(ORDER_TYPES),
    size: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_INT,
        description: 'Cantidad exacta de acciones. Excluyente con `amount`.',
      }),
    ),
    amount: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        maximum: 1_000_000_000_000,
        description:
          'Monto total en pesos. Se opera la mayor cantidad entera de acciones que ese monto paga. Excluyente con `size`.',
      }),
    ),
    price: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        maximum: 99_999_999.99,
        description: 'Precio límite en pesos. Obligatorio en LIMIT, no permitido en MARKET.',
      }),
    ),
  },
  { additionalProperties: false, title: 'PlaceOrderRequest' },
);

export const OrderResponse = Type.Object(
  {
    id: Type.Integer(),
    userId: Type.Integer(),
    instrumentId: Type.Integer(),
    side: Type.String(),
    type: Type.Enum(ORDER_TYPES),
    status: Type.Enum(ORDER_STATUSES),
    size: Type.Integer({ description: 'Cantidad de acciones' }),
    price: Type.Number({ description: 'Precio por acción, en pesos' }),
    total: Type.Number({ description: 'size × price, en pesos' }),
    rejectionReason: Type.Union([Type.String(), Type.Null()], {
      description: 'Motivo cuando el estado es REJECTED',
    }),
    datetime: Type.String({ format: 'date-time' }),
  },
  { title: 'Order' },
);

/** La misma orden, devuelta ante un pedido repetido. */
export const ReplayedOrderResponse = {
  ...OrderResponse,
  description: 'Pedido repetido: es la orden original',
};
