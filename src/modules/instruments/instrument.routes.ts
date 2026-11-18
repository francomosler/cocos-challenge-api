import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { ErrorResponse } from '../../shared/http-schemas.ts';
import { presentInstrument } from './instrument.mappers.ts';
import { InstrumentResponse, SearchQuery } from './instrument.schemas.ts';
import type { SearchInstruments } from './search-instruments.ts';

const searchSchema = {
  tags: ['Instrumentos'],
  summary: 'Buscar activos por ticker o nombre',
  querystring: SearchQuery,
  response: { 200: Type.Array(InstrumentResponse), 400: ErrorResponse, 503: ErrorResponse },
};

export function instrumentRoutes(
  searchInstruments: Pick<SearchInstruments, 'execute'>,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get('/instruments', { schema: searchSchema }, async (request) => {
      const found = await searchInstruments.execute(request.query.q, request.query.limit);
      return found.map(presentInstrument);
    });
  };
}
