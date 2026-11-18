/**
 * Dinero como cantidad entera de centavos en BigInt.
 *
 * `size * price` puede superar el entero seguro de JavaScript (2^53) y los decimales
 * binarios no representan 0,10 de forma exacta, así que toda la aritmética monetaria
 * del dominio pasa por acá. Los `number` solo aparecen en el borde HTTP.
 */
export type Cents = bigint;

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export class InvalidMoneyError extends Error {
  constructor(value: unknown, reason: string) {
    super(`Importe inválido (${String(value)}): ${reason}`);
    this.name = 'InvalidMoneyError';
  }
}

/**
 * Convierte un decimal no negativo ("930", "930.5", "930.50") a centavos.
 * Rechaza más de 2 decimales significativos en vez de redondear en silencio.
 */
export function parseCents(value: string | number): Cents {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new InvalidMoneyError(value, 'no es un número finito');
  }
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) throw new InvalidMoneyError(value, 'se esperaba un decimal no negativo');

  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > 2) throw new InvalidMoneyError(value, 'admite hasta 2 decimales');

  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** Como `parseCents`, pero admite signo. Para leer saldos y sumas de Postgres. */
export function parseSignedCents(value: string): Cents {
  const text = value.trim();
  return text.startsWith('-') ? -parseCents(text.slice(1)) : parseCents(text);
}

/** Centavos a decimal con 2 dígitos, listo para un parámetro NUMERIC de Postgres. */
export function formatCents(cents: Cents): string {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${sign}${absolute / 100n}.${fraction}`;
}

/** Centavos a `number` en pesos, solo para serializar respuestas JSON. */
export function centsToNumber(cents: Cents): number {
  return Number(cents) / 100;
}

/** Importe total de `quantity` unidades a `unitPrice`. */
export function totalFor(quantity: number | bigint, unitPrice: Cents): Cents {
  return BigInt(quantity) * unitPrice;
}

/** Cuántas unidades enteras se pueden pagar con `amount` a `unitPrice`. */
export function wholeUnitsFor(amount: Cents, unitPrice: Cents): bigint {
  if (unitPrice <= 0n) throw new InvalidMoneyError(unitPrice, 'el precio debe ser positivo');
  return amount / unitPrice;
}

/**
 * Variación porcentual de `from` a `to`, redondeada a 2 decimales (mitad lejos de cero).
 * Devuelve `null` cuando no hay base contra la cual comparar.
 */
export function percentChange(from: Cents, to: Cents): number | null {
  if (from <= 0n) return null;
  const scaled = (to - from) * 1_000_000n; // porcentaje con 4 decimales
  const hundredths = roundDivide(scaled, from * 100n);
  return Number(hundredths) / 100;
}

/** División entera redondeando al más cercano, mitad lejos de cero. Divisor positivo. */
export function roundDivide(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}
