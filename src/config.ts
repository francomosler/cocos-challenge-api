import type { AdmissionLimits } from './shared/admission.ts';

export interface DatabaseConfig {
  url: string;
  /** Schema de Postgres a usar; los tests apuntan cada archivo a uno efímero. */
  schema: string | null;
  poolMax: number;
  connectTimeoutMs: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  db: DatabaseConfig;
  /** Cuántos pedidos se atienden a la vez, en total y por cuenta. */
  admission: AdmissionLimits;
}

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Configuración inválida: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Lee variables de entorno y junta todos los problemas, para informarlos de una vez. */
class EnvReader {
  readonly problems: string[] = [];
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  required(name: string): string {
    const value = this.env[name] ?? '';
    if (value === '') this.problems.push(`${name} es obligatoria`);
    return value;
  }

  positiveInt(name: string, fallback: number): number {
    const raw = this.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) return value;
    this.problems.push(`${name} debe ser un entero positivo (recibido "${raw}")`);
    return fallback;
  }

  /** El nombre de schema se interpola en la conexión: solo se aceptan identificadores simples. */
  schemaName(name: string): string | null {
    const value = this.env[name] ?? null;
    if (value !== null && !/^[a-z_][a-z0-9_]*$/.test(value)) {
      this.problems.push(`${name} solo admite minúsculas, dígitos y guion bajo`);
    }
    return value;
  }
}

/**
 * Límites del control de admisión. Los valores por defecto salen de mediciones (ver
 * docs/base-de-datos.md, sección 4.1): dos pedidos de una cuenta a la vez terminan antes que
 * diez, y 500 pedidos en curso son unos 0,2 s de espera a la capacidad de una instancia.
 */
function readAdmissionLimits(reader: EnvReader): AdmissionLimits {
  return {
    maxInFlight: reader.positiveInt('MAX_IN_FLIGHT_REQUESTS', 500),
    account: {
      concurrency: reader.positiveInt('ACCOUNT_MAX_CONCURRENT', 2),
      maxQueued: reader.positiveInt('ACCOUNT_MAX_QUEUED', 20),
      maxWaitMs: reader.positiveInt('ACCOUNT_MAX_WAIT_MS', 2000),
    },
  };
}

export function loadConfig(env: Env = process.env): Config {
  const reader = new EnvReader(env);

  const config: Config = {
    port: reader.positiveInt('PORT', 3000),
    host: env.HOST ?? '0.0.0.0',
    logLevel: env.LOG_LEVEL ?? 'info',
    db: {
      url: reader.required('DATABASE_URL'),
      schema: reader.schemaName('DB_SCHEMA'),
      poolMax: reader.positiveInt('DB_POOL_MAX', 10),
      connectTimeoutMs: reader.positiveInt('DB_CONNECT_TIMEOUT_MS', 5000),
      lockTimeoutMs: reader.positiveInt('DB_LOCK_TIMEOUT_MS', 3000),
      statementTimeoutMs: reader.positiveInt('DB_STATEMENT_TIMEOUT_MS', 5000),
    },
    admission: readAdmissionLimits(reader),
  };

  if (reader.problems.length > 0) throw new ConfigError(reader.problems);
  return config;
}
