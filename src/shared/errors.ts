/**
 * Errores propios de la aplicación.
 *
 * Cada error declara una categoría de negocio, no un status HTTP: la traducción a HTTP
 * vive en un único lugar (`plugins/error-handler.ts`). El dominio y los casos de uso
 * nunca conocen el protocolo.
 */
export type ErrorCategory =
  | 'INVALID_REQUEST' // el pedido está mal formado o es incoherente
  | 'NOT_FOUND' // el recurso referido no existe
  | 'CONFLICT' // el recurso existe pero su estado no admite la operación
  | 'UNPROCESSABLE' // el pedido es válido pero una regla de negocio lo impide
  | 'TOO_MANY_REQUESTS' // quien lo manda ya tiene demasiados pedidos en curso
  | 'UNAVAILABLE'; // falla transitoria: conviene reintentar

export type ErrorDetails = Record<string, unknown>;

export abstract class AppError extends Error {
  abstract readonly category: ErrorCategory;
  readonly code: string;
  readonly details: ErrorDetails | undefined;

  constructor(code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class InvalidRequestError extends AppError {
  readonly category = 'INVALID_REQUEST';
}

export class NotFoundError extends AppError {
  readonly category = 'NOT_FOUND';
}

export class ConflictError extends AppError {
  readonly category = 'CONFLICT';
}

export class BusinessRuleError extends AppError {
  readonly category = 'UNPROCESSABLE';
}

export interface TooManyRequestsOptions {
  retryAfterSeconds?: number;
  details?: ErrorDetails;
}

/** El pedido es válido, pero se rechaza sin atenderlo: conviene esperar y reintentar. */
export class TooManyRequestsError extends AppError {
  readonly category = 'TOO_MANY_REQUESTS';
  readonly retryAfterSeconds: number;

  constructor(code: string, message: string, options: TooManyRequestsOptions = {}) {
    super(code, message, options.details);
    this.retryAfterSeconds = options.retryAfterSeconds ?? 1;
  }
}

export interface UnavailableOptions {
  retryAfterSeconds?: number;
  /** Motivo técnico (lock_timeout, pool_timeout, ...). Va al log, no a la respuesta. */
  reason?: string;
  cause?: unknown;
}

export class ServiceUnavailableError extends AppError {
  readonly category = 'UNAVAILABLE';
  readonly retryAfterSeconds: number;
  readonly reason: string | undefined;

  constructor(code: string, message: string, options: UnavailableOptions = {}) {
    super(code, message);
    this.retryAfterSeconds = options.retryAfterSeconds ?? 1;
    this.reason = options.reason;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Una invariante interna no se cumplió: es un bug, no un error del cliente. */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}

export class UserNotFoundError extends NotFoundError {
  constructor(userId: number) {
    super('USER_NOT_FOUND', `No existe el usuario ${userId}`, { userId });
  }
}

export class InstrumentNotFoundError extends NotFoundError {
  constructor(instrumentId: number) {
    super('INSTRUMENT_NOT_FOUND', `No existe el instrumento ${instrumentId}`, { instrumentId });
  }
}
