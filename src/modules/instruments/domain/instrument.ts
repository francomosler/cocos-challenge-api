import { type Cents, percentChange } from '../../../shared/money.ts';

export interface Instrument {
  id: number;
  ticker: string;
  name: string;
  type: string;
}

/** Último precio conocido de un instrumento. */
export interface Quote {
  close: Cents;
  previousClose: Cents | null;
  date: string;
}

/** Un instrumento con su última cotización, si alguna vez cotizó. */
export interface QuotedInstrument extends Instrument {
  quote: Quote | null;
}

/** Los pesos están modelados como un instrumento más, de tipo MONEDA. */
export const CASH_TICKER = 'ARS';
export const CASH_TYPE = 'MONEDA';

/** Se puede comprar y vender todo lo que no sea moneda. */
export function isTradable(instrument: Instrument): boolean {
  return instrument.type !== CASH_TYPE;
}

/** Variación del día: `close` contra `previousClose`. Sin cierre anterior no hay variación. */
export function dailyReturnPercent(quote: Quote): number | null {
  return quote.previousClose === null ? null : percentChange(quote.previousClose, quote.close);
}
