import type { Static } from 'typebox';
import { centsToNumber } from '../../shared/money.ts';
import { dailyReturnPercent, type QuotedInstrument } from './domain/instrument.ts';
import type { InstrumentResponse } from './instrument.schemas.ts';

/** Del dominio (centavos exactos) a la respuesta JSON (pesos). */
export function presentInstrument(instrument: QuotedInstrument): Static<typeof InstrumentResponse> {
  const { quote } = instrument;
  return {
    id: instrument.id,
    ticker: instrument.ticker,
    name: instrument.name,
    type: instrument.type,
    lastPrice: quote ? centsToNumber(quote.close) : null,
    previousClose: quote?.previousClose != null ? centsToNumber(quote.previousClose) : null,
    dailyReturnPercent: quote ? dailyReturnPercent(quote) : null,
    priceDate: quote?.date ?? null,
  };
}
