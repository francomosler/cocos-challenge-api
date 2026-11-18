import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

/** Documentación OpenAPI generada desde los mismos esquemas que validan cada ruta. */
export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Cocos Challenge API',
        version: '1.0.0',
        description:
          'Portfolio, búsqueda de activos y órdenes. API interna: en producción la consume un BFF, que es quien autentica al usuario.',
      },
      tags: [
        { name: 'Portfolio' },
        { name: 'Instrumentos' },
        { name: 'Órdenes' },
        { name: 'Operación' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
}
