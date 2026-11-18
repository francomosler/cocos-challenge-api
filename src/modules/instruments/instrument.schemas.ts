import { Type } from 'typebox';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from './search-instruments.ts';

const nullableNumber = (description?: string) =>
  Type.Union([Type.Number(), Type.Null()], description ? { description } : {});

export const SearchQuery = Type.Object({
  q: Type.String({
    minLength: 1,
    maxLength: 50,
    description: 'Texto a buscar en el ticker o en el nombre',
  }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT }),
  ),
});

export const InstrumentResponse = Type.Object(
  {
    id: Type.Integer(),
    ticker: Type.String(),
    name: Type.String(),
    type: Type.String(),
    lastPrice: nullableNumber('Último `close`, en pesos'),
    previousClose: nullableNumber(),
    dailyReturnPercent: nullableNumber('Variación del día, en %'),
    priceDate: Type.Union([Type.String(), Type.Null()], {
      description: 'Fecha del último precio (YYYY-MM-DD)',
    }),
  },
  { title: 'Instrument' },
);
