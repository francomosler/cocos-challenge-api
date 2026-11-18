import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { escapeLikePattern } from '../../src/modules/instruments/instrument.repository.ts';
import { normalizeSearchText } from '../../src/modules/instruments/search-instruments.ts';
import { InvalidRequestError } from '../../src/shared/errors.ts';

describe('texto de búsqueda', () => {
  it('ignora los espacios de los bordes', () => {
    assert.equal(normalizeSearchText('  pam '), 'pam');
    assert.equal(normalizeSearchText('Banco Macro'), 'Banco Macro');
  });

  it('rechaza una búsqueda vacía o de solo espacios', () => {
    for (const text of ['', '   ', '\t\n']) {
      assert.throws(
        () => normalizeSearchText(text),
        (error: unknown) => error instanceof InvalidRequestError && error.code === 'EMPTY_SEARCH',
      );
    }
  });

  it('rechaza caracteres de control, incluido el nulo que la base no acepta', () => {
    for (const text of ['a\u0000b', '\u0000', 'pam\tpa', 'uno\ndos', 'x\u007f', 'y\u0085z']) {
      assert.throws(
        () => normalizeSearchText(text),
        (error: unknown) =>
          error instanceof InvalidRequestError && error.code === 'INVALID_SEARCH_TEXT',
        JSON.stringify(text),
      );
    }
  });

  it('acepta acentos, símbolos y otros alfabetos', () => {
    for (const text of ['Río de la Plata', 'S.A.', "O'Higgins", '100%', 'ñandú', '日本', '😀']) {
      assert.equal(normalizeSearchText(text), text);
    }
  });

  it('el repositorio escapa los comodines de LIKE', () => {
    assert.equal(escapeLikePattern('100%'), '100\\%');
    assert.equal(escapeLikePattern('a_b'), 'a\\_b');
    assert.equal(escapeLikePattern('c:\\x'), 'c:\\\\x');
    assert.equal(escapeLikePattern('PAMP'), 'PAMP');
    assert.equal(escapeLikePattern('%_%'), '\\%\\_\\%');
  });
});

describe('configuración', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

  it('usa valores por defecto razonables', () => {
    const config = loadConfig(base);
    assert.equal(config.port, 3000);
    assert.equal(config.db.poolMax, 10);
    assert.equal(config.db.schema, null);
    assert.deepEqual(config.admission, {
      maxInFlight: 500,
      account: { concurrency: 2, maxQueued: 20, maxWaitMs: 2000 },
    });
  });

  it('toma los valores del entorno', () => {
    const config = loadConfig({ ...base, PORT: '8080', DB_POOL_MAX: '25', DB_SCHEMA: 'test_abc' });
    assert.equal(config.port, 8080);
    assert.equal(config.db.poolMax, 25);
    assert.equal(config.db.schema, 'test_abc');
  });

  it('toma del entorno los límites del control de admisión', () => {
    const config = loadConfig({
      ...base,
      MAX_IN_FLIGHT_REQUESTS: '50',
      ACCOUNT_MAX_CONCURRENT: '1',
      ACCOUNT_MAX_QUEUED: '5',
      ACCOUNT_MAX_WAIT_MS: '250',
    });
    assert.deepEqual(config.admission, {
      maxInFlight: 50,
      account: { concurrency: 1, maxQueued: 5, maxWaitMs: 250 },
    });
  });

  it('un límite de admisión en cero o negativo no arranca: dejaría a la API sin atender', () => {
    for (const name of [
      'MAX_IN_FLIGHT_REQUESTS',
      'ACCOUNT_MAX_CONCURRENT',
      'ACCOUNT_MAX_QUEUED',
      'ACCOUNT_MAX_WAIT_MS',
    ]) {
      for (const value of ['0', '-1', '2.5', 'muchos']) {
        assert.throws(
          () => loadConfig({ ...base, [name]: value }),
          (error: unknown) => error instanceof ConfigError && error.message.includes(name),
          `${name}=${value}`,
        );
      }
    }
  });

  it('exige DATABASE_URL', () => {
    assert.throws(() => loadConfig({}), ConfigError);
  });

  it('rechaza números inválidos e informa todos los problemas juntos', () => {
    assert.throws(
      () => loadConfig({ PORT: 'abc', DB_POOL_MAX: '0', DB_LOCK_TIMEOUT_MS: '1.5' }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('DATABASE_URL') &&
        error.message.includes('PORT') &&
        error.message.includes('DB_POOL_MAX') &&
        error.message.includes('DB_LOCK_TIMEOUT_MS'),
    );
  });

  it('no acepta un nombre de schema que podría inyectar SQL', () => {
    assert.throws(() => loadConfig({ ...base, DB_SCHEMA: 'x; DROP TABLE orders' }), ConfigError);
  });
});
