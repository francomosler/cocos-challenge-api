import { Type } from 'typebox';

/** Mayor valor de una columna INT de Postgres. */
export const MAX_INT = 2_147_483_647;

export const IdParam = (description: string) =>
  Type.Integer({ minimum: 1, maximum: MAX_INT, description });

/** Formato único de error de toda la API. */
export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String({ description: 'Código estable, pensado para que lo lea un programa' }),
      message: Type.String({ description: 'Explicación para una persona' }),
      details: Type.Optional(Type.Unknown()),
      requestId: Type.String(),
    }),
  },
  { title: 'ErrorResponse' },
);
