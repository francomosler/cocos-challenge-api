import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  type ErrorCategory,
  ServiceUnavailableError,
  TooManyRequestsError,
} from '../shared/errors.ts';

/** Único lugar donde una categoría de error de negocio se convierte en status HTTP. */
const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  UNAVAILABLE: 503,
};

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

function send(request: FastifyRequest, reply: FastifyReply, status: number, body: ErrorBody) {
  return reply.code(status).send({ error: { ...body, requestId: request.id } });
}

/** Falla transitoria: nada quedó confirmado y se puede reintentar con la misma key. */
function handleUnavailable(
  error: ServiceUnavailableError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  reply.header('Retry-After', String(error.retryAfterSeconds));
  // El motivo técnico queda en el log para operar; al cliente solo le llega el código.
  request.log.warn(
    { event: 'request.unavailable', code: error.code, reason: error.reason },
    error.message,
  );
  return send(request, reply, 503, { code: error.code, message: error.message });
}

/** El pedido se entendió, pero una regla de negocio o un límite de uso lo rechaza. */
function handleAppError(error: AppError, request: FastifyRequest, reply: FastifyReply) {
  const status = STATUS_BY_CATEGORY[error.category];
  if (error instanceof TooManyRequestsError) {
    reply.header('Retry-After', String(error.retryAfterSeconds));
  }
  request.log.info({ event: 'request.refused', code: error.code, status }, error.message);
  return send(request, reply, status, {
    code: error.code,
    message: error.message,
    details: error.details,
  });
}

/** El pedido no cumple el esquema de la ruta. */
function handleValidationError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  request.log.info({ event: 'request.invalid', in: error.validationContext }, error.message);
  return send(request, reply, 400, {
    code: 'VALIDATION_ERROR',
    message: error.message,
    details: {
      in: error.validationContext,
      issues: (error.validation ?? []).map((issue) => ({
        path: issue.instancePath,
        rule: issue.keyword,
        message: issue.message,
        params: issue.params,
      })),
    },
  });
}

/** Errores del propio framework por culpa del pedido: JSON mal formado, cuerpo muy grande, etc. */
function handleClientError(
  error: FastifyError,
  status: number,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  request.log.info({ event: 'request.invalid', code: error.code }, error.message);
  return send(request, reply, status, {
    code: error.code ?? 'BAD_REQUEST',
    message: error.message,
  });
}

/** Cualquier otra cosa es un bug o una falla no prevista: se registra entera y no se filtra nada. */
function handleUnexpected(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  request.log.error({ event: 'request.failed', err: error }, 'Error no controlado');
  return send(request, reply, 500, {
    code: 'INTERNAL_ERROR',
    message: 'Error interno; si el problema persiste, informá el requestId',
  });
}

function isClientError(status: number | undefined): status is number {
  return status !== undefined && status >= 400 && status < 500;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof ServiceUnavailableError) return handleUnavailable(error, request, reply);
    if (error instanceof AppError) return handleAppError(error, request, reply);
    if (error.validation) return handleValidationError(error, request, reply);
    if (isClientError(error.statusCode)) {
      return handleClientError(error, error.statusCode, request, reply);
    }
    return handleUnexpected(error, request, reply);
  });

  app.setNotFoundHandler((request, reply) =>
    send(request, reply, 404, {
      code: 'ROUTE_NOT_FOUND',
      message: `No existe ${request.method} ${request.url}`,
    }),
  );
}
