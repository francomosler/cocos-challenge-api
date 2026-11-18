import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Las capas no son solo una convención: estos tests fallan si una dependencia apunta
 * para el lado equivocado.
 *
 *   rutas / esquemas / mapeos ─► casos de uso ─► puertos ─► dominio
 *                                                   ▲
 *                              repositorios ────────┘   (implementan los puertos)
 */
const SRC = join(import.meta.dirname, '..', '..', 'src');

type Layer = 'domain' | 'port' | 'use-case' | 'http' | 'repository' | 'other';

function layerOf(file: string): Layer {
  if (file.includes('/domain/')) return 'domain';
  if (/shared\/(money|errors|logger)\.ts$/.test(file)) return 'domain';
  if (file.endsWith('/ports.ts') || file.endsWith('shared/unit-of-work.ts')) return 'port';
  if (file.endsWith('.repository.ts')) return 'repository';
  if (/\.(routes|schemas|mappers)\.ts$/.test(file)) return 'http';
  if (file.includes('/modules/')) return 'use-case';
  return 'other'; // app.ts, server.ts, config.ts, plugins/, shared/db.ts, shared/admission.ts, ...
}

interface SourceFile {
  path: string;
  layer: Layer;
  imports: string[];
}

async function sourceFiles(): Promise<SourceFile[]> {
  const entries = await readdir(SRC, { withFileTypes: true, recursive: true });
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
  return Promise.all(
    paths.map(async (path) => ({
      path: relative(SRC, path),
      layer: layerOf(path),
      imports: [...(await readFile(path, 'utf8')).matchAll(/from\s+'([^']+)'/g)].map(
        (match) => match[1] ?? '',
      ),
    })),
  );
}

const isFramework = (imported: string) => /^(pg|fastify|typebox|ajv|@fastify\/.*)$/.test(imported);
const isDatabase = (imported: string) => imported === 'pg' || imported.endsWith('shared/db.ts');
const isRepository = (imported: string) => imported.endsWith('.repository.ts');
const isHttp = (imported: string) => /\.(routes|schemas|mappers)\.ts$/.test(imported);
async function violations(
  layers: Layer[],
  forbidden: (imported: string, file: SourceFile) => boolean,
): Promise<string[]> {
  const found: string[] = [];
  for (const file of (await sourceFiles()).filter((f) => layers.includes(f.layer))) {
    for (const imported of file.imports) {
      if (forbidden(imported, file)) found.push(`${file.path} importa ${imported}`);
    }
  }
  return found;
}

describe('separación de capas', () => {
  it('clasifica todos los archivos de los módulos en una capa', async () => {
    const byLayer = Object.groupBy(await sourceFiles(), (file) => file.layer);
    for (const layer of ['domain', 'port', 'use-case', 'http', 'repository'] as const) {
      assert.ok((byLayer[layer]?.length ?? 0) > 0, `no hay archivos en la capa ${layer}`);
    }
    assert.deepEqual((byLayer['use-case'] ?? []).map((file) => file.path).sort(), [
      'modules/instruments/search-instruments.ts',
      'modules/orders/cancel-order.ts',
      'modules/orders/place-order.ts',
      'modules/portfolio/get-portfolio.ts',
    ]);
  });

  it('el dominio solo importa dominio: ni frameworks, ni base, ni puertos, ni casos de uso', async () => {
    assert.deepEqual(
      await violations(
        ['domain'],
        (imported) =>
          isFramework(imported) ||
          isDatabase(imported) ||
          isRepository(imported) ||
          isHttp(imported) ||
          imported.endsWith('/ports.ts') ||
          imported.endsWith('unit-of-work.ts'),
      ),
      [],
    );
  });

  it('los puertos solo se apoyan en el dominio y en otros puertos', async () => {
    assert.deepEqual(
      await violations(
        ['port'],
        (imported) =>
          isFramework(imported) ||
          isDatabase(imported) ||
          isRepository(imported) ||
          isHttp(imported),
      ),
      [],
    );
  });

  it('los casos de uso dependen de puertos, no de Postgres ni de HTTP', async () => {
    assert.deepEqual(
      await violations(
        ['use-case'],
        (imported) =>
          isFramework(imported) ||
          isDatabase(imported) ||
          isRepository(imported) ||
          isHttp(imported),
      ),
      [],
    );
  });

  it('la capa HTTP no llega a la base: pasa por los casos de uso', async () => {
    assert.deepEqual(
      await violations(
        ['http'],
        (imported) => imported === 'pg' || isDatabase(imported) || isRepository(imported),
      ),
      [],
    );
  });

  it('los repositorios no conocen HTTP ni casos de uso', async () => {
    assert.deepEqual(
      await violations(
        ['repository'],
        (imported) =>
          /^(fastify|typebox|ajv|@fastify\/.*)$/.test(imported) ||
          isHttp(imported) ||
          /\/(place-order|cancel-order|get-portfolio|search-instruments)\.ts$/.test(imported),
      ),
      [],
    );
  });

  it('solo los repositorios y la base compartida usan el driver de Postgres', async () => {
    const offenders = (await sourceFiles())
      .filter((file) => file.imports.includes('pg'))
      .map((file) => file.path)
      .filter(
        (path) =>
          !path.endsWith('.repository.ts') &&
          !['shared/db.ts', 'shared/migrator.ts', 'app.ts'].includes(path),
      );
    assert.deepEqual(offenders, []);
  });

  it('el control de admisión se aplica en la raíz de composición: ninguna capa lo conoce', async () => {
    assert.deepEqual(
      await violations(['domain', 'port', 'use-case', 'http', 'repository'], (imported) =>
        imported.endsWith('shared/admission.ts'),
      ),
      [],
    );
    const users = (await sourceFiles())
      .filter((file) => file.imports.some((imported) => imported.endsWith('shared/admission.ts')))
      .map((file) => file.path)
      .sort();
    assert.deepEqual(users, ['app.ts', 'config.ts']);
  });

  it('el control de admisión no depende de HTTP ni de la base: solo de los errores', async () => {
    const admission = (await sourceFiles()).find((file) => file.path === 'shared/admission.ts');
    assert.deepEqual(admission?.imports, ['./errors.ts']);
  });

  it('cada repositorio implementa un puerto', async () => {
    const missing: string[] = [];
    for (const file of (await sourceFiles()).filter((f) => f.layer === 'repository')) {
      const source = await readFile(join(SRC, file.path), 'utf8');
      const declaresClass = /export class \w+/.test(source);
      if (declaresClass && !/export class Pg\w+ implements \w+/.test(source)) {
        missing.push(file.path);
      }
    }
    assert.deepEqual(missing, []);
  });
});
