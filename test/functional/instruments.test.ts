import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fc from 'fast-check';
import { type ErrorJson, get } from '../helpers/actions.ts';
import { createTestContext, type TestContext } from '../helpers/test-context.ts';

interface InstrumentJson {
  id: number;
  ticker: string;
  name: string;
  type: string;
  lastPrice: number | null;
  previousClose: number | null;
  dailyReturnPercent: number | null;
  priceDate: string | null;
}

describe('GET /instruments', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await createTestContext();
  });
  after(() => ctx?.close());

  const search = (query: string) =>
    get<InstrumentJson[]>(ctx.app, `/instruments?${new URLSearchParams({ q: query })}`);
  const tickers = async (query: string) =>
    (await search(query)).body.map((instrument) => instrument.ticker);

  it('busca por ticker y devuelve el activo con su último precio', async () => {
    const { status, body } = await search('PAMP');
    assert.equal(status, 200);
    assert.deepEqual(body, [
      {
        id: 47,
        ticker: 'PAMP',
        name: 'Pampa Holding S.A.',
        type: 'ACCIONES',
        lastPrice: 925.85,
        previousClose: 921.8,
        dailyReturnPercent: 0.44,
        priceDate: '2023-07-14',
      },
    ]);
  });

  it('no distingue mayúsculas de minúsculas', async () => {
    assert.deepEqual(await tickers('pamp'), ['PAMP']);
    assert.deepEqual(await tickers('PaMp'), ['PAMP']);
  });

  it('busca por una parte del ticker', async () => {
    assert.deepEqual(await tickers('pam'), ['PAMP']);
  });

  it('busca por una parte del nombre', async () => {
    assert.deepEqual(await tickers('banco'), ['BBAR', 'BHIP', 'BMA', 'BPAT']);
    assert.deepEqual(await tickers('Pampa Holding'), ['PAMP']);
  });

  it('busca en ticker y nombre a la vez, y pone primero los tickers que empiezan con el texto', async () => {
    // "mol": MOLA y MOLI por ticker; GRIM (Grimoldi) y SEMI (Molinos Juan Semino) por nombre.
    assert.deepEqual(await tickers('mol'), ['MOLA', 'MOLI', 'GRIM', 'SEMI']);
  });

  it('el ticker exacto va primero aunque otros también coincidan', async () => {
    const found = await tickers('BMA');
    assert.equal(found[0], 'BMA');
  });

  it('ignora espacios alrededor del texto', async () => {
    assert.deepEqual(await tickers('  pamp  '), ['PAMP']);
  });

  it('sin coincidencias devuelve una lista vacía', async () => {
    const { status, body } = await search('zzzzzz');
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });

  it('no devuelve la moneda: ARS no es un activo del mercado', async () => {
    for (const query of ['ARS', 'pesos', 'a']) {
      const { body } = await search(query);
      assert.equal(
        body.some((instrument) => instrument.type === 'MONEDA'),
        false,
        query,
      );
    }
  });

  it('un activo sin cotización aparece con precio nulo', async () => {
    const { body } = await search('PGR');
    assert.deepEqual(body, [
      {
        id: 3,
        ticker: 'PGR',
        name: 'Phoenix Global Resources',
        type: 'ACCIONES',
        lastPrice: null,
        previousClose: null,
        dailyReturnPercent: null,
        priceDate: null,
      },
    ]);
  });

  describe('caracteres especiales', () => {
    it('"%" y "_" se buscan como texto, no como comodines', async () => {
      assert.deepEqual(await tickers('%'), []);
      assert.deepEqual(await tickers('_'), []);
      assert.deepEqual(await tickers('P_MP'), []);
      assert.deepEqual(await tickers('P%P'), []);
    });

    it('el punto de un nombre se encuentra literalmente', async () => {
      const found = await search('S.A.');
      assert.ok(found.body.length > 0);
      assert.ok(found.body.every((instrument) => instrument.name.includes('S.A.')));
    });

    it('un intento de inyección SQL es solo un texto que no coincide con nada', async () => {
      const { status, body } = await search("'; DROP TABLE instruments; --");
      assert.equal(status, 200);
      assert.deepEqual(body, []);
      const { rows } = await ctx.pool.query('SELECT count(*)::int AS total FROM instruments');
      assert.equal(rows[0].total, 66);
    });

    it('acepta acentos', async () => {
      assert.deepEqual(await tickers('Río de la Plata'), ['MOLI']);
    });
  });

  describe('límite de resultados', () => {
    it('por defecto devuelve hasta 20', async () => {
      const { body } = await search('a');
      assert.equal(body.length, 20);
    });

    it('respeta el límite pedido', async () => {
      const { body } = await get<InstrumentJson[]>(ctx.app, '/instruments?q=a&limit=3');
      assert.equal(body.length, 3);
    });

    it('admite hasta 100', async () => {
      const { status, body } = await get<InstrumentJson[]>(ctx.app, '/instruments?q=a&limit=100');
      assert.equal(status, 200);
      assert.equal(body.length, 59); // los 60 que contienen "a", menos ARS
    });

    for (const limit of ['0', '-1', '101', 'abc', '1.5']) {
      it(`limit=${limit} → 400`, async () => {
        const { status, body } = await get<ErrorJson>(ctx.app, `/instruments?q=a&limit=${limit}`);
        assert.equal(status, 400);
        assert.equal(body.error.code, 'VALIDATION_ERROR');
      });
    }
  });

  describe('búsquedas inválidas', () => {
    it('sin "q" → 400', async () => {
      const { status, body } = await get<ErrorJson>(ctx.app, '/instruments');
      assert.equal(status, 400);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    });

    it('"q" vacío → 400', async () => {
      const { status } = await get<ErrorJson>(ctx.app, '/instruments?q=');
      assert.equal(status, 400);
    });

    it('"q" de solo espacios → 400', async () => {
      const { status, body } = await search('   ');
      assert.equal(status, 400);
      assert.equal((body as unknown as ErrorJson).error.code, 'EMPTY_SEARCH');
    });

    it('"q" de más de 50 caracteres → 400', async () => {
      const { status } = await search('x'.repeat(51));
      assert.equal(status, 400);
    });

    for (const [name, text] of [
      ['el carácter nulo', '\u0000'],
      ['un nulo en el medio', 'pa\u0000mp'],
      ['una tabulación en el medio', 'pa\tmp'],
      ['un salto de línea en el medio', 'pa\nmp'],
    ] as const) {
      it(`"q" con ${name} → 400, no un error interno`, async () => {
        const { status, body } = await search(text);
        assert.equal(status, 400);
        assert.equal((body as unknown as ErrorJson).error.code, 'INVALID_SEARCH_TEXT');
      });
    }
  });

  describe('propiedades', () => {
    interface CatalogRow {
      id: number;
      ticker: string;
      name: string;
      type: string;
    }
    let tradable: CatalogRow[];
    before(async () => {
      const { rows } = await ctx.pool.query<CatalogRow>(
        "SELECT id, ticker, name, type FROM instruments WHERE type <> 'MONEDA'",
      );
      tradable = rows;
    });

    const contains = (instrument: InstrumentJson, needle: string) =>
      instrument.ticker.toLowerCase().includes(needle) ||
      instrument.name.toLowerCase().includes(needle);

    it('cualquier fragmento del ticker o del nombre de un activo lo encuentra', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.nat(),
          fc.constantFrom('ticker' as const, 'name' as const),
          fc.nat(),
          fc.integer({ min: 1, max: 12 }),
          async (index, field, start, length) => {
            const instrument = tradable[index % tradable.length] as CatalogRow;
            const text = instrument[field];
            const from = start % text.length;
            const fragment = text.slice(from, from + length);
            fc.pre(fragment.trim() !== '');

            const { status, body } = await get<InstrumentJson[]>(
              ctx.app,
              `/instruments?${new URLSearchParams({ q: fragment, limit: '100' })}`,
            );

            assert.equal(status, 200);
            assert.ok(
              body.some((found) => found.id === instrument.id),
              `"${fragment}" no encontró a ${instrument.ticker}`,
            );
            // Y no devuelve nada de más: todo resultado contiene el fragmento.
            const needle = fragment.trim().toLowerCase();
            assert.ok(body.every((found) => contains(found, needle)));
          },
        ),
        { numRuns: 300 },
      );
    });

    it('ningún texto rompe la búsqueda: responde 200 o 400, nunca un error interno', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ unit: 'binary', minLength: 1, maxLength: 50 }),
          async (text) => {
            const response = await ctx.app.inject({
              method: 'GET',
              url: `/instruments?${new URLSearchParams({ q: text, limit: '100' })}`,
            });
            assert.ok(
              response.statusCode === 200 || response.statusCode === 400,
              `${JSON.stringify(text)} → ${response.statusCode} ${response.body}`,
            );
          },
        ),
        { numRuns: 500 },
      );
    });

    it('los comodines y símbolos se buscan literalmente: nunca devuelven de más', async () => {
      // Textos armados solo con caracteres que en SQL o en LIKE tienen significado.
      const symbols = fc.string({
        unit: fc.constantFrom('%', '_', '\\', "'", '"', ';', '-', '*', '.', ' ', 'a', 'S'),
        minLength: 1,
        maxLength: 8,
      });
      await fc.assert(
        fc.asyncProperty(symbols, async (text) => {
          fc.pre(text.trim() !== '');
          const { status, body } = await get<InstrumentJson[]>(
            ctx.app,
            `/instruments?${new URLSearchParams({ q: text, limit: '100' })}`,
          );
          assert.equal(status, 200);
          const needle = text.trim().toLowerCase();
          assert.ok(
            body.every((found) => contains(found, needle)),
            `${JSON.stringify(text)} devolvió activos que no lo contienen`,
          );
        }),
        { numRuns: 300 },
      );
    });
  });
});
