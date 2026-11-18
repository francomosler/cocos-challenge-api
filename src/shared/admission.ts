import { ServiceUnavailableError, TooManyRequestsError } from './errors.ts';

/**
 * Control de admisión: decide si un pedido entra a trabajar contra la base, espera su
 * turno o se rechaza en el momento. Protege un recurso escaso y compartido, las
 * conexiones a Postgres, de dos formas:
 *
 *   - Turnos por cuenta. Los pedidos de una misma cuenta compiten por las mismas filas de
 *     saldo, así que Postgres igual los hace esperar; la diferencia es dónde. Sin turnos,
 *     cada uno espera adentro de la base ocupando una conexión, y una sola cuenta puede
 *     quedarse con todas. Con turnos esperan acá, en memoria, y las conexiones quedan
 *     para las demás cuentas.
 *   - Tope global. Pasado cierto número de pedidos en curso, aceptar más solo alarga la
 *     espera de todos: el excedente se rechaza en el momento.
 *
 * No decide nada de negocio ni garantiza consistencia: que no se gaste dos veces el mismo
 * saldo lo siguen garantizando los UPDATE condicionales en Postgres. Por eso puede vivir
 * en la memoria de cada instancia y perderse en un reinicio sin consecuencias.
 */
export interface AccountTurnLimits {
  /** Pedidos de una misma cuenta que pueden estar trabajando a la vez. */
  concurrency: number;
  /** Pedidos de una misma cuenta que pueden esperar turno; el siguiente se rechaza. */
  maxQueued: number;
  /** Cuánto espera un pedido su turno antes de darse por vencido. */
  maxWaitMs: number;
}

export interface AdmissionLimits {
  /** Pedidos que la instancia atiende a la vez, sumando los que esperan turno. */
  maxInFlight: number;
  account: AccountTurnLimits;
}

/** Un pedido en espera: `admit` le da el turno y `timer` lo da por vencido. */
interface Waiter {
  admit: () => void;
  timer: NodeJS.Timeout;
}

/** Los pedidos de una cuenta: cuántos trabajan y quiénes esperan, por orden de llegada. */
interface Line {
  running: number;
  waiting: Waiter[];
}

function queueFull(accountId: number): TooManyRequestsError {
  return new TooManyRequestsError(
    'TOO_MANY_REQUESTS',
    `La cuenta ${accountId} ya tiene demasiados pedidos en curso; reintentá en unos instantes`,
    { details: { userId: accountId } },
  );
}

function turnTimedOut(): ServiceUnavailableError {
  return new ServiceUnavailableError(
    'ACCOUNT_BUSY',
    'Los pedidos anteriores de la cuenta todavía no terminaron; reintentá en unos instantes',
    { reason: 'account_turn_timeout' },
  );
}

function serverBusy(): ServiceUnavailableError {
  return new ServiceUnavailableError(
    'SERVER_BUSY',
    'El servicio está atendiendo el máximo de pedidos simultáneos; reintentá en unos instantes',
    { reason: 'in_flight_limit' },
  );
}

/**
 * Turnos por cuenta: hasta `concurrency` pedidos de una cuenta trabajan a la vez y el
 * resto espera en orden de llegada. La cola es acotada (el que no entra recibe un
 * rechazo inmediato) y la espera tiene plazo.
 */
export class AccountTurns {
  private readonly limits: AccountTurnLimits;
  private readonly lines = new Map<number, Line>();

  constructor(limits: AccountTurnLimits) {
    this.limits = limits;
  }

  /** Cuentas con algún pedido trabajando o esperando. */
  get busyAccounts(): number {
    return this.lines.size;
  }

  async run<T>(accountId: number, work: () => Promise<T>): Promise<T> {
    const line = await this.takeTurn(accountId);
    try {
      return await work();
    } finally {
      this.passTurn(accountId, line);
    }
  }

  /** Rechaza en el momento si la cuenta no puede recibir otro pedido: ni trabajar ni esperar. */
  assertRoom(accountId: number): void {
    const line = this.lines.get(accountId);
    if (!line || line.running < this.limits.concurrency) return;
    if (line.waiting.length >= this.limits.maxQueued) throw queueFull(accountId);
  }

  private async takeTurn(accountId: number): Promise<Line> {
    this.assertRoom(accountId);
    const line = this.lineOf(accountId);
    if (line.running < this.limits.concurrency) line.running += 1;
    else await this.waitInLine(line);
    return line;
  }

  private lineOf(accountId: number): Line {
    let line = this.lines.get(accountId);
    if (!line) {
      line = { running: 0, waiting: [] };
      this.lines.set(accountId, line);
    }
    return line;
  }

  /** Espera en memoria, sin ocupar ninguna conexión, hasta recibir el turno o vencer el plazo. */
  private waitInLine(line: Line): Promise<void> {
    return new Promise((admit, reject) => {
      const timer = setTimeout(() => {
        line.waiting = line.waiting.filter((waiter) => waiter.timer !== timer);
        reject(turnTimedOut());
      }, this.limits.maxWaitMs);
      line.waiting.push({ admit, timer });
    });
  }

  private passTurn(accountId: number, line: Line): void {
    const next = line.waiting.shift();
    if (next) {
      // El que termina le deja su lugar al primero de la cola: `running` no cambia.
      clearTimeout(next.timer);
      next.admit();
      return;
    }
    line.running -= 1;
    if (line.running === 0) this.lines.delete(accountId);
  }
}

/** Tope de pedidos en curso: el que no entra se rechaza en el momento, sin esperar. */
export class InFlightLimit {
  private readonly max: number;
  private current = 0;

  constructor(max: number) {
    this.max = max;
  }

  get inFlight(): number {
    return this.current;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.current >= this.max) throw serverBusy();
    this.current += 1;
    try {
      return await work();
    } finally {
      this.current -= 1;
    }
  }
}

export class Admission {
  private readonly capacity: InFlightLimit;
  private readonly turns: AccountTurns;

  constructor(limits: AdmissionLimits) {
    this.capacity = new InFlightLimit(limits.maxInFlight);
    this.turns = new AccountTurns(limits.account);
  }

  /** Pedido que no pertenece a una cuenta (la búsqueda): solo cuenta para el tope global. */
  run<T>(work: () => Promise<T>): Promise<T> {
    return this.capacity.run(work);
  }

  /**
   * Pedido de una cuenta: cuenta para el tope global y, además, espera su turno.
   * Primero se mira la cuenta: su excedente recibe el rechazo que le corresponde y no
   * llega a ocupar, ni por un instante, una plaza que podría usar otra cuenta.
   */
  async runForAccount<T>(accountId: number, work: () => Promise<T>): Promise<T> {
    this.turns.assertRoom(accountId);
    return this.capacity.run(() => this.turns.run(accountId, work));
  }

  /** Cuánto hay en curso en este momento. Vuelve a cero cuando no queda ningún pedido. */
  snapshot(): { inFlight: number; busyAccounts: number } {
    return { inFlight: this.capacity.inFlight, busyAccounts: this.turns.busyAccounts };
  }
}
