import type { Instrument, QuotedInstrument } from './domain/instrument.ts';

/** Catálogo de instrumentos del mercado. */
export interface InstrumentCatalog {
  findById(instrumentId: number): Promise<Instrument | null>;

  /** El instrumento que representa a los pesos. */
  findCash(): Promise<Instrument | null>;

  findWithQuotes(instrumentIds: number[]): Promise<QuotedInstrument[]>;

  /**
   * Instrumentos operables cuyo ticker o nombre contiene `text`, sin distinguir mayúsculas.
   * `text` se busca literalmente: no tiene comodines.
   * Orden: ticker exacto, después tickers que empiezan con el texto, después alfabético.
   */
  search(text: string, limit: number): Promise<QuotedInstrument[]>;
}
