/** Lo que un caso de uso necesita para dejar registro; el logger de Fastify lo cumple. */
export interface Logger {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
};
