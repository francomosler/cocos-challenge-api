import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';

const Health = Type.Object({ status: Type.String() });

/** Se resuelve si las dependencias de la instancia responden; falla si no. */
export type ReadinessCheck = () => Promise<unknown>;

const liveSchema = {
  tags: ['Operación'],
  summary: 'El proceso está vivo',
  response: { 200: Health },
};

const readySchema = {
  tags: ['Operación'],
  summary: 'La instancia puede atender pedidos',
  response: { 200: Health, 503: Health },
};

export function healthRoutes(checkDependencies: ReadinessCheck): FastifyPluginAsyncTypebox {
  return async (app) => {
    // El proceso responde. No toca dependencias: un orquestador lo usa para reiniciar.
    app.get('/health/live', { schema: liveSchema }, async () => ({ status: 'ok' }));

    // La instancia puede atender tráfico: sus dependencias responden.
    app.get('/health/ready', { schema: readySchema }, async (_request, reply) => {
      try {
        await checkDependencies();
        return { status: 'ok' };
      } catch {
        return reply.code(503).send({ status: 'unavailable' });
      }
    });
  };
}
