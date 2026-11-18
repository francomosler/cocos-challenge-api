import { Type } from 'typebox';
import { IdParam } from '../../shared/http-schemas.ts';

const nullableNumber = (description: string) =>
  Type.Union([Type.Number(), Type.Null()], { description });

export const PortfolioParams = Type.Object({ userId: IdParam('Id del usuario') });

const PositionResponse = Type.Object({
  instrumentId: Type.Integer(),
  ticker: Type.String(),
  name: Type.String(),
  quantity: Type.Integer({ description: 'Cantidad de acciones en cartera' }),
  reservedQuantity: Type.Integer({
    description: 'Acciones comprometidas en ventas LIMIT pendientes',
  }),
  averageCost: Type.Number({ description: 'Costo promedio ponderado por acción, en pesos' }),
  lastPrice: nullableNumber('Último `close`, en pesos'),
  marketValue: nullableNumber('Valor de la posición: cantidad × último precio'),
  totalReturnPercent: nullableNumber('Rendimiento total contra el costo, en %'),
  dailyReturnPercent: nullableNumber('Variación del día, en %'),
});

export const PortfolioResponse = Type.Object(
  {
    userId: Type.Integer(),
    totalAccountValue: Type.Number({
      description: 'Pesos (disponibles y reservados) más el valor de mercado de las posiciones',
    }),
    availableCash: Type.Number({ description: 'Pesos disponibles para operar' }),
    reservedCash: Type.Number({
      description: 'Pesos comprometidos en compras LIMIT pendientes',
    }),
    positions: Type.Array(PositionResponse),
  },
  { title: 'Portfolio' },
);
