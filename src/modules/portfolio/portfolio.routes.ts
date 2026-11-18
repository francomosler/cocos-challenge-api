import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ErrorResponse } from '../../shared/http-schemas.ts';
import type { GetPortfolio } from './get-portfolio.ts';
import { presentPortfolio } from './portfolio.mappers.ts';
import { PortfolioParams, PortfolioResponse } from './portfolio.schemas.ts';

const portfolioSchema = {
  tags: ['Portfolio'],
  summary: 'Valor de la cuenta, pesos disponibles y posiciones de un usuario',
  params: PortfolioParams,
  response: {
    200: PortfolioResponse,
    400: ErrorResponse,
    404: ErrorResponse,
    429: ErrorResponse,
    503: ErrorResponse,
  },
};

export function portfolioRoutes(
  getPortfolio: Pick<GetPortfolio, 'execute'>,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get('/users/:userId/portfolio', { schema: portfolioSchema }, async (request) =>
      presentPortfolio(await getPortfolio.execute(request.params.userId)),
    );
  };
}
