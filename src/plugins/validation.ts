import { Ajv } from 'ajv';
import type { FastifyInstance } from 'fastify';

/**
 * Validación de entrada con dos criterios:
 *
 * - Ruta, query y headers siempre llegan como texto, así que ahí se convierten tipos
 *   ("42" → 42).
 * - El cuerpo JSON ya trae tipos, y se valida sin convertir nada. Por defecto Fastify
 *   convertiría `true` en 1 o `"10"` en 10: en una orden eso transformaría un error del
 *   cliente en una operación real. Tampoco se descartan en silencio las propiedades
 *   desconocidas: un campo mal escrito ("prize") se rechaza.
 */
export function registerValidation(app: FastifyInstance): void {
  const coercing = new Ajv({ coerceTypes: 'array', useDefaults: true, removeAdditional: false });
  const strict = new Ajv({ coerceTypes: false, useDefaults: true, removeAdditional: false });

  app.setValidatorCompiler(({ schema, httpPart }) =>
    (httpPart === 'body' ? strict : coercing).compile(schema),
  );
}
