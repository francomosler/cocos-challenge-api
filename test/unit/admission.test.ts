import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { AccountTurns, Admission, InFlightLimit } from '../../src/shared/admission.ts';
import { ServiceUnavailableError, TooManyRequestsError } from '../../src/shared/errors.ts';

/**
 * El control de admisión, sin base ni HTTP: trabajos que el test deja en curso el tiempo
 * que quiere y un reloj simulado para los plazos.
 */

/** Un trabajo que queda en curso hasta que el test decide terminarlo. */
class Job {
  started = false;
  private readonly outcome = Promise.withResolvers<string>();

  readonly work = (): Promise<string> => {
    this.started = true;
    return this.outcome.promise;
  };

  finish(value = 'ok'): void {
    this.outcome.resolve(value);
  }

  fail(error: Error): void {
    this.outcome.reject(error);
  }
}

const jobs = (count: number) => Array.from({ length: count }, () => new Job());
const started = (list: Job[]) => list.map((job) => job.started);

/** Deja correr todo lo que ya puede avanzar (promesas resueltas, turnos entregados). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Resultado de un pedido, sin que un rechazo corte el test. */
const outcomeOf = <T>(promise: Promise<T>): Promise<T | Error> =>
  promise.catch((error: Error) => error);

const isQueueFull = (error: unknown) =>
  error instanceof TooManyRequestsError && error.code === 'TOO_MANY_REQUESTS';
const isTurnTimeout = (error: unknown) =>
  error instanceof ServiceUnavailableError && error.code === 'ACCOUNT_BUSY';
const isServerBusy = (error: unknown) =>
  error instanceof ServiceUnavailableError && error.code === 'SERVER_BUSY';

const ACCOUNT = 7;
const OTHER_ACCOUNT = 8;

describe('turnos por cuenta', () => {
  const limits = { concurrency: 2, maxQueued: 3, maxWaitMs: 1_000 };
  const oneAtATime = { ...limits, concurrency: 1 };

  it('deja trabajar a la vez hasta el límite y hace esperar al resto', async () => {
    const turns = new AccountTurns(limits);
    const [first, second, third] = jobs(3) as [Job, Job, Job];
    const results = [first, second, third].map((job) => turns.run(ACCOUNT, job.work));
    await settle();
    assert.deepEqual(started([first, second, third]), [true, true, false]);

    first.finish('a');
    await settle();
    assert.equal(third.started, true, 'al terminar uno, entra el que esperaba');

    second.finish('b');
    third.finish('c');
    assert.deepEqual(await Promise.all(results), ['a', 'b', 'c']);
  });

  it('da los turnos en orden de llegada', async () => {
    const turns = new AccountTurns({ ...oneAtATime, maxQueued: 10 });
    const order: number[] = [];
    const list = jobs(6);
    const results = list.map((job, index) =>
      turns.run(ACCOUNT, () => {
        order.push(index);
        return job.work();
      }),
    );

    for (const job of list) {
      await settle();
      job.finish();
    }
    await Promise.all(results);

    assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  });

  it('cuentas distintas no se esperan entre sí', async () => {
    const turns = new AccountTurns(oneAtATime);
    const [mine, minePending, theirs] = jobs(3) as [Job, Job, Job];
    const results = [
      turns.run(ACCOUNT, mine.work),
      turns.run(ACCOUNT, minePending.work),
      turns.run(OTHER_ACCOUNT, theirs.work),
    ];
    await settle();

    assert.deepEqual(started([mine, minePending, theirs]), [true, false, true]);
    assert.equal(turns.busyAccounts, 2);

    for (const job of [mine, minePending, theirs]) job.finish();
    await Promise.all(results);
  });

  it('si el trabajo falla, propaga el error y pasa el turno', async () => {
    const turns = new AccountTurns(oneAtATime);
    const [failing, next] = jobs(2) as [Job, Job];
    const failed = outcomeOf(turns.run(ACCOUNT, failing.work));
    const succeeded = turns.run(ACCOUNT, next.work);
    await settle();

    const boom = new Error('se cayó la base');
    failing.fail(boom);
    assert.equal(await failed, boom);
    await settle();
    assert.equal(next.started, true);

    next.finish('sigue');
    assert.equal(await succeeded, 'sigue');
    assert.equal(turns.busyAccounts, 0);
  });

  it('si el trabajo lanza antes de devolver una promesa, también pasa el turno', async () => {
    const turns = new AccountTurns(oneAtATime);
    const boom = new Error('falló al empezar');
    const next = new Job();

    const failed = outcomeOf(
      turns.run(ACCOUNT, () => {
        throw boom;
      }),
    );
    const succeeded = turns.run(ACCOUNT, next.work);

    assert.equal(await failed, boom);
    await settle();
    next.finish();
    assert.equal(await succeeded, 'ok');
    assert.equal(turns.busyAccounts, 0);
  });

  it('con la cola llena rechaza en el momento y no ejecuta el trabajo', async () => {
    const turns = new AccountTurns(limits); // 2 trabajando + 3 esperando
    const admitted = jobs(5);
    const results = admitted.map((job) => turns.run(ACCOUNT, job.work));
    const extra = new Job();

    const rejection = await outcomeOf(turns.run(ACCOUNT, extra.work));

    assert.ok(rejection instanceof TooManyRequestsError);
    assert.equal(rejection.code, 'TOO_MANY_REQUESTS');
    assert.equal(rejection.category, 'TOO_MANY_REQUESTS');
    assert.equal(rejection.retryAfterSeconds, 1);
    assert.deepEqual(rejection.details, { userId: ACCOUNT });
    assert.equal(extra.started, false);

    for (const job of admitted) {
      await settle();
      job.finish();
    }
    await Promise.all(results);
  });

  it('la cola llena de una cuenta no afecta a las otras', async () => {
    const turns = new AccountTurns({ ...oneAtATime, maxQueued: 1 });
    const [running, waiting, theirs] = jobs(3) as [Job, Job, Job];
    const results = [turns.run(ACCOUNT, running.work), turns.run(ACCOUNT, waiting.work)];
    assert.ok(isQueueFull(await outcomeOf(turns.run(ACCOUNT, new Job().work))));

    const other = turns.run(OTHER_ACCOUNT, theirs.work);
    await settle();
    assert.equal(theirs.started, true);

    theirs.finish('libre');
    assert.equal(await other, 'libre');
    running.finish();
    await settle();
    waiting.finish();
    await Promise.all(results);
  });

  it('un rechazo no altera la cola: los que esperaban conservan su turno', async () => {
    const turns = new AccountTurns({ ...oneAtATime, maxQueued: 2 });
    const [running, second, third] = jobs(3) as [Job, Job, Job];
    const results = [running, second, third].map((job) => turns.run(ACCOUNT, job.work));
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.ok(isQueueFull(await outcomeOf(turns.run(ACCOUNT, new Job().work))));
    }

    running.finish();
    await settle();
    assert.deepEqual(started([second, third]), [true, false]);
    second.finish();
    await settle();
    assert.equal(third.started, true);
    third.finish();
    await Promise.all(results);
  });

  it('si el turno no llega dentro del plazo, rechaza y el trabajo no se ejecuta nunca', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const turns = new AccountTurns(oneAtATime);
    const [stuck, late] = jobs(2) as [Job, Job];
    const running = turns.run(ACCOUNT, stuck.work);
    const expired = outcomeOf(turns.run(ACCOUNT, late.work));

    t.mock.timers.tick(999);
    await settle();
    assert.equal(late.started, false, 'todavía espera');

    t.mock.timers.tick(1);
    const rejection = await expired;
    assert.ok(rejection instanceof ServiceUnavailableError);
    assert.equal(rejection.code, 'ACCOUNT_BUSY');
    assert.equal(rejection.reason, 'account_turn_timeout');
    assert.equal(rejection.retryAfterSeconds, 1);

    stuck.finish();
    await running;
    await settle();
    assert.equal(late.started, false, 'un pedido vencido no recibe el turno después');
    assert.equal(turns.busyAccounts, 0);
  });

  it('cada pedido tiene su propio plazo, contado desde que empezó a esperar', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const turns = new AccountTurns(oneAtATime);
    const [stuck, early, later] = jobs(3) as [Job, Job, Job];
    const running = turns.run(ACCOUNT, stuck.work);
    const earlyOutcome = outcomeOf(turns.run(ACCOUNT, early.work));
    t.mock.timers.tick(400);
    const laterOutcome = turns.run(ACCOUNT, later.work);

    t.mock.timers.tick(600); // el primero lleva 1.000 ms esperando; el segundo, 600
    assert.ok(isTurnTimeout(await earlyOutcome));

    // El turno saltea al vencido y le llega al que sigue esperando.
    stuck.finish();
    await running;
    await settle();
    assert.deepEqual(started([early, later]), [false, true]);
    later.finish('llegó');
    assert.equal(await laterOutcome, 'llegó');
  });

  it('un pedido que ya recibió su turno no vence', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const turns = new AccountTurns(oneAtATime);
    const [first, second] = jobs(2) as [Job, Job];
    const firstResult = turns.run(ACCOUNT, first.work);
    const secondResult = turns.run(ACCOUNT, second.work);

    t.mock.timers.tick(500);
    first.finish();
    await firstResult;
    await settle();
    assert.equal(second.started, true);

    t.mock.timers.tick(10_000); // muy pasado su plazo de espera, pero ya está trabajando
    second.finish('terminó');
    assert.equal(await secondResult, 'terminó');
  });

  it('un pedido vencido deja su lugar en la cola a otro', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const turns = new AccountTurns({ ...oneAtATime, maxQueued: 1 });
    const [stuck, expiring, replacement] = jobs(3) as [Job, Job, Job];
    const running = turns.run(ACCOUNT, stuck.work);
    const expired = outcomeOf(turns.run(ACCOUNT, expiring.work));
    assert.ok(isQueueFull(await outcomeOf(turns.run(ACCOUNT, new Job().work))));

    t.mock.timers.tick(1_000);
    assert.ok(isTurnTimeout(await expired));

    const replaced = turns.run(ACCOUNT, replacement.work); // ahora hay lugar para esperar
    stuck.finish();
    await running;
    await settle();
    assert.equal(replacement.started, true);
    replacement.finish();
    await replaced;
    assert.equal(turns.busyAccounts, 0);
  });
});

describe('tope de pedidos en curso', () => {
  it('admite hasta el tope y rechaza el siguiente en el momento, sin ejecutarlo', async () => {
    const limit = new InFlightLimit(3);
    const admitted = jobs(3);
    const results = admitted.map((job) => limit.run(job.work));
    const extra = new Job();

    const rejection = await outcomeOf(limit.run(extra.work));

    assert.ok(rejection instanceof ServiceUnavailableError);
    assert.equal(rejection.code, 'SERVER_BUSY');
    assert.equal(rejection.reason, 'in_flight_limit');
    assert.equal(rejection.retryAfterSeconds, 1);
    assert.equal(extra.started, false);
    assert.deepEqual(started(admitted), [true, true, true]);
    assert.equal(limit.inFlight, 3);

    for (const job of admitted) job.finish();
    await Promise.all(results);
  });

  it('libera el lugar cuando el trabajo termina, bien o mal', async () => {
    const limit = new InFlightLimit(1);
    const [succeeding, failing, last] = jobs(3) as [Job, Job, Job];

    const first = limit.run(succeeding.work);
    assert.ok(isServerBusy(await outcomeOf(limit.run(new Job().work))));
    succeeding.finish();
    await first;

    const second = outcomeOf(limit.run(failing.work));
    failing.fail(new Error('falló'));
    assert.ok((await second) instanceof Error);

    const third = limit.run(last.work);
    last.finish('entra');
    assert.equal(await third, 'entra');
    assert.equal(limit.inFlight, 0);
  });
});

describe('control de admisión', () => {
  const limits = { maxInFlight: 4, account: { concurrency: 1, maxQueued: 2, maxWaitMs: 1_000 } };

  it('los pedidos de una cuenta esperan turno; los que no son de una cuenta, no', async () => {
    const admission = new Admission(limits);
    const [order, secondOrder, search, anotherSearch] = jobs(4) as [Job, Job, Job, Job];
    const results = [
      admission.runForAccount(ACCOUNT, order.work),
      admission.runForAccount(ACCOUNT, secondOrder.work),
      admission.run(search.work),
      admission.run(anotherSearch.work),
    ];
    await settle();

    assert.deepEqual(started([order, secondOrder, search, anotherSearch]), [
      true,
      false,
      true,
      true,
    ]);
    assert.deepEqual(admission.snapshot(), { inFlight: 4, busyAccounts: 1 });

    for (const job of [order, search, anotherSearch]) job.finish();
    await settle();
    secondOrder.finish();
    await Promise.all(results);
    assert.deepEqual(admission.snapshot(), { inFlight: 0, busyAccounts: 0 });
  });

  it('los pedidos que esperan turno también cuentan para el tope global', async () => {
    const admission = new Admission({ ...limits, maxInFlight: 3 });
    const mine = jobs(3); // 1 trabajando + 2 esperando: las 3 plazas de la instancia
    const results = mine.map((job) => admission.runForAccount(ACCOUNT, job.work));

    assert.ok(
      isServerBusy(await outcomeOf(admission.runForAccount(OTHER_ACCOUNT, new Job().work))),
    );
    assert.ok(isServerBusy(await outcomeOf(admission.run(new Job().work))));

    for (const job of mine) {
      await settle();
      job.finish();
    }
    await Promise.all(results);
  });

  it('un rechazo por cola llena no ocupa lugar en el tope global', async () => {
    const admission = new Admission(limits); // tope 4; la cuenta admite 1 + 2
    const mine = jobs(3);
    const results = mine.map((job) => admission.runForAccount(ACCOUNT, job.work));
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.ok(isQueueFull(await outcomeOf(admission.runForAccount(ACCOUNT, new Job().work))));
    }
    assert.equal(admission.snapshot().inFlight, 3);

    // Queda una plaza y la puede usar otra cuenta.
    const theirs = new Job();
    const other = admission.runForAccount(OTHER_ACCOUNT, theirs.work);
    await settle();
    assert.equal(theirs.started, true);

    theirs.finish();
    for (const job of mine) {
      await settle();
      job.finish();
    }
    await Promise.all([other, ...results]);
    assert.deepEqual(admission.snapshot(), { inFlight: 0, busyAccounts: 0 });
  });

  it('en una ráfaga, el excedente de una cuenta recibe su rechazo y no le quita plazas a las demás', async () => {
    const admission = new Admission(limits); // tope 4; la cuenta admite 1 + 2
    // 100 pedidos de la misma cuenta en el mismo instante, sin dejar correr nada entre uno y otro.
    const mine = jobs(100);
    const outcomes = mine.map((job) => outcomeOf(admission.runForAccount(ACCOUNT, job.work)));
    assert.equal(admission.snapshot().inFlight, 3, 'solo cuentan los 3 que la cuenta admite');

    const theirs = new Job();
    const other = admission.runForAccount(OTHER_ACCOUNT, theirs.work);
    await settle();
    assert.equal(theirs.started, true, 'queda una plaza y la usa otra cuenta');

    theirs.finish();
    for (const job of mine.slice(0, 3)) {
      await settle();
      job.finish();
    }
    const results = await Promise.all(outcomes);
    assert.deepEqual(results.slice(0, 3), ['ok', 'ok', 'ok']);
    assert.ok(results.slice(3).every(isQueueFull), 'el excedente es 429, nunca 503');
    assert.deepEqual(
      started(mine.slice(3)),
      Array.from({ length: 97 }, () => false),
    );
    await other;
  });

  it('si la cuenta y la instancia están llenas a la vez, el rechazo es el de la cuenta', async () => {
    const admission = new Admission({ ...limits, maxInFlight: 3 }); // la cuenta llena la instancia
    const mine = jobs(3);
    const results = mine.map((job) => admission.runForAccount(ACCOUNT, job.work));

    assert.ok(isQueueFull(await outcomeOf(admission.runForAccount(ACCOUNT, new Job().work))));
    assert.ok(
      isServerBusy(await outcomeOf(admission.runForAccount(OTHER_ACCOUNT, new Job().work))),
    );

    for (const job of mine) {
      await settle();
      job.finish();
    }
    await Promise.all(results);
  });

  it('un pedido rechazado por el tope global no llega a ocupar la cola de su cuenta', async () => {
    const admission = new Admission({ ...limits, maxInFlight: 1 });
    const search = new Job();
    const running = admission.run(search.work);

    assert.ok(isServerBusy(await outcomeOf(admission.runForAccount(ACCOUNT, new Job().work))));
    assert.deepEqual(admission.snapshot(), { inFlight: 1, busyAccounts: 0 });

    search.finish();
    await running;
  });

  it('un pedido que vence esperando turno también libera su plaza global', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const admission = new Admission(limits);
    const stuck = new Job();
    const running = admission.runForAccount(ACCOUNT, stuck.work);
    const expired = outcomeOf(admission.runForAccount(ACCOUNT, new Job().work));
    assert.equal(admission.snapshot().inFlight, 2);

    t.mock.timers.tick(1_000);
    assert.ok(isTurnTimeout(await expired));
    assert.equal(admission.snapshot().inFlight, 1);

    stuck.finish();
    await running;
    assert.deepEqual(admission.snapshot(), { inFlight: 0, busyAccounts: 0 });
  });
});

/**
 * Propiedad: para cualquier secuencia de llegadas y finalizaciones, los turnos se comportan
 * como un modelo escrito aparte (una lista de "trabajando" y otra de "esperando" por cuenta).
 */
type Step = { kind: 'arrive'; account: number } | { kind: 'finish'; pick: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('arrive' as const), account: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant('finish' as const), pick: fc.nat() }),
);

class TurnsModel {
  readonly everStarted = new Set<Job>();
  readonly rejected = new Set<Job>();
  private readonly lines = new Map<number, { running: Job[]; waiting: Job[] }>();
  private readonly concurrency: number;
  private readonly maxQueued: number;

  constructor(concurrency: number, maxQueued: number) {
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
  }

  arrive(account: number, job: Job): void {
    const line = this.lines.get(account) ?? { running: [], waiting: [] };
    this.lines.set(account, line);
    if (line.running.length < this.concurrency) this.start(line.running, job);
    else if (line.waiting.length < this.maxQueued) line.waiting.push(job);
    else this.rejected.add(job);
  }

  /** Termina uno de los trabajos en curso y devuelve cuál; `null` si no hay ninguno. */
  finish(pick: number): Job | null {
    const running = [...this.lines.values()].flatMap((line) => line.running);
    const job = running[pick % Math.max(running.length, 1)];
    if (!job) return null;
    for (const line of this.lines.values()) {
      if (!line.running.includes(job)) continue;
      line.running.splice(line.running.indexOf(job), 1);
      const next = line.waiting.shift();
      if (next) this.start(line.running, next);
    }
    return job;
  }

  private start(running: Job[], job: Job): void {
    running.push(job);
    this.everStarted.add(job);
  }
}

describe('propiedades de los turnos por cuenta', () => {
  it('para cualquier secuencia de llegadas y finalizaciones, coincide con el modelo', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); // los plazos no intervienen en esta propiedad
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 0, max: 4 }),
        fc.array(stepArb, { maxLength: 60 }),
        async (concurrency, maxQueued, steps) => {
          const turns = new AccountTurns({ concurrency, maxQueued, maxWaitMs: 60_000 });
          const model = new TurnsModel(concurrency, maxQueued);
          const all: Array<{ job: Job; outcome: Promise<string | Error> }> = [];

          const check = async () => {
            await settle();
            for (const { job } of all) {
              assert.equal(job.started, model.everStarted.has(job));
            }
          };

          for (const step of steps) {
            if (step.kind === 'arrive') {
              const job = new Job();
              all.push({ job, outcome: outcomeOf(turns.run(step.account, job.work)) });
              model.arrive(step.account, job);
            } else {
              model.finish(step.pick)?.finish();
            }
            await check();
          }

          // Se termina todo lo que quedó en curso: nadie queda esperando para siempre.
          for (let job = model.finish(0); job; job = model.finish(0)) {
            job.finish();
            await check();
          }
          for (const { job, outcome } of all) {
            const result = await outcome;
            if (model.rejected.has(job)) assert.ok(isQueueFull(result));
            else assert.equal(result, 'ok');
          }
          assert.equal(turns.busyAccounts, 0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
