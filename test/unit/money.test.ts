import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  centsToNumber,
  formatCents,
  InvalidMoneyError,
  parseCents,
  parseSignedCents,
  percentChange,
  roundDivide,
  totalFor,
  wholeUnitsFor,
} from '../../src/shared/money.ts';

describe('parseCents', () => {
  const valid: Array<[string | number, bigint]> = [
    ['930', 93000n],
    ['930.5', 93050n],
    ['930.50', 93050n],
    ['0.01', 1n],
    ['20.50000000', 2050n], // así vienen los precios en database.sql
    [925.85, 92585n],
    [0.1, 10n],
    [1_000_000, 100_000_000n],
    ['99999999.99', 9_999_999_999n],
  ];
  for (const [input, expected] of valid) {
    it(`convierte ${JSON.stringify(input)} a ${expected} centavos`, () => {
      assert.equal(parseCents(input), expected);
    });
  }

  const invalid: Array<string | number> = [
    '10.123', // más de 2 decimales: no se redondea en silencio
    10.005,
    '-5',
    -5,
    'abc',
    '',
    '1e3',
    1e-7,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '1,50',
  ];
  for (const input of invalid) {
    it(`rechaza ${JSON.stringify(String(input))}`, () => {
      assert.throws(() => parseCents(input), InvalidMoneyError);
    });
  }

  it('no pierde precisión donde un number sí la pierde', () => {
    // 0.1 + 0.2 !== 0.3 en coma flotante; en centavos la suma es exacta.
    assert.equal(parseCents(0.1) + parseCents(0.2), parseCents(0.3));
  });
});

describe('parseSignedCents y formatCents', () => {
  it('lee saldos negativos', () => {
    assert.equal(parseSignedCents('-10.00'), -1000n);
    assert.equal(parseSignedCents('753000.00'), 75_300_000n);
  });

  it('formatea siempre con 2 decimales', () => {
    assert.equal(formatCents(93050n), '930.50');
    assert.equal(formatCents(5n), '0.05');
    assert.equal(formatCents(0n), '0.00');
    assert.equal(formatCents(-1000n), '-10.00');
  });

  it('ida y vuelta devuelve el mismo valor', () => {
    for (const cents of [0n, 1n, 99n, 100n, 92585n, 9_999_999_999n]) {
      assert.equal(parseCents(formatCents(cents)), cents);
    }
  });
});

describe('aritmética', () => {
  it('totalFor multiplica cantidad por precio sin desbordar', () => {
    assert.equal(totalFor(50, 93000n), 4_650_000n);
    // INT máximo de Postgres × precio máximo: supera 2^53, BigInt lo representa exacto.
    assert.equal(totalFor(2_147_483_647, 9_999_999_999n), 21_474_836_467_852_516_353n);
  });

  it('wholeUnitsFor descarta la fracción', () => {
    assert.equal(wholeUnitsFor(100_000n, 92585n), 1n); // $1000 a $925,85
    assert.equal(wholeUnitsFor(92585n, 92585n), 1n);
    assert.equal(wholeUnitsFor(92584n, 92585n), 0n);
    assert.equal(wholeUnitsFor(1_000_000n, 6000n), 166n);
  });

  it('wholeUnitsFor exige un precio positivo', () => {
    assert.throws(() => wholeUnitsFor(100n, 0n), InvalidMoneyError);
  });

  it('roundDivide redondea la mitad lejos de cero', () => {
    assert.equal(roundDivide(5n, 2n), 3n);
    assert.equal(roundDivide(-5n, 2n), -3n);
    assert.equal(roundDivide(4n, 3n), 1n);
    assert.equal(roundDivide(-4n, 3n), -1n);
  });

  it('centsToNumber devuelve pesos', () => {
    assert.equal(centsToNumber(3_703_400n), 37034);
    assert.equal(centsToNumber(92585n), 925.85);
  });
});

describe('percentChange', () => {
  it('calcula la variación con 2 decimales', () => {
    assert.equal(percentChange(3_720_000n, 3_703_400n), -0.45); // PAMP del seed
    assert.equal(percentChange(12_500_000n, 11_475_000n), -8.2); // METR del seed
    assert.equal(percentChange(92180n, 92585n), 0.44);
    assert.equal(percentChange(100n, 200n), 100);
    assert.equal(percentChange(100n, 100n), 0);
  });

  it('no hay variación sin una base positiva', () => {
    assert.equal(percentChange(0n, 100n), null);
    assert.equal(percentChange(-5n, 100n), null);
  });
});
