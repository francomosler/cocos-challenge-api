/**
 * Unidad de trabajo: todo lo que `work` haga a través de `context` se confirma junto o
 * no se confirma, y lo que lea lo ve de forma consistente.
 *
 * Es un puerto. Los casos de uso dependen de esta interfaz y no saben que detrás hay una
 * transacción de Postgres: en los tests unitarios se reemplaza por una versión en memoria.
 *
 * `Context` es lo que el caso de uso puede usar dentro de la unidad de trabajo: los
 * almacenes que necesita, ya atados a esa transacción.
 */
export interface UnitOfWork<Context> {
  run<T>(work: (context: Context) => Promise<T>): Promise<T>;
}
