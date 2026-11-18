import { InvalidRequestError } from '../../shared/errors.ts';
import type { QuotedInstrument } from './domain/instrument.ts';
import type { InstrumentCatalog } from './ports.ts';

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

/** Caracteres de control (nulo, tabulación, salto de línea, ...): no forman parte de un nombre. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Quita los espacios de los bordes y exige que quede un texto buscable.
 * Los caracteres de control se rechazan acá: no pueden coincidir con ningún activo y el
 * carácter nulo, además, no es un texto válido para la base.
 */
export function normalizeSearchText(rawQuery: string): string {
  const text = rawQuery.trim();
  if (text === '') {
    throw new InvalidRequestError('EMPTY_SEARCH', 'La búsqueda no puede estar vacía');
  }
  if (CONTROL_CHARACTER.test(text)) {
    throw new InvalidRequestError(
      'INVALID_SEARCH_TEXT',
      'La búsqueda no puede contener caracteres de control',
    );
  }
  return text;
}

export class SearchInstruments {
  private readonly instruments: Pick<InstrumentCatalog, 'search'>;

  constructor(instruments: Pick<InstrumentCatalog, 'search'>) {
    this.instruments = instruments;
  }

  async execute(query: string, limit: number = DEFAULT_SEARCH_LIMIT): Promise<QuotedInstrument[]> {
    return this.instruments.search(normalizeSearchText(query), limit);
  }
}
