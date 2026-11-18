import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { QuotedInstrument } from '../../src/modules/instruments/domain/instrument.ts';
import { CancelOrder } from '../../src/modules/orders/cancel-order.ts';
import {
  AmountBelowUnitPriceError,
  IdempotencyKeyReuseError,
  InstrumentNotTradableError,
  InvalidOrderError,
  MarketPriceUnavailableError,
  OrderNotCancellableError,
  OrderNotFoundError,
} from '../../src/modules/orders/domain/order-errors.ts';
import { PlaceOrder, type PlaceOrderCommand } from '../../src/modules/orders/place-order.ts';
import type { OrderStore } from '../../src/modules/orders/ports.ts';
import {
  InstrumentNotFoundError,
  InvariantViolationError,
  UserNotFoundError,
} from '../../src/shared/errors.ts';
import {
  InMemoryInstruments,
  InMemoryMarketPrices,
  InMemoryOrderBook,
  InMemoryUsers,
  RecordingLogger,
} from '../helpers/in-memory.ts';

/**
 * Los casos de uso probados contra dobles en memoria de sus puertos: sin HTTP y sin base.
 * Acá se verifica la orquestación: qué se valida antes de escribir, qué se graba, qué se
 * registra en el log y qué pasa en los caminos que con una base real son difíciles de
 * provocar (una carrera por la misma key, una falla al grabar).
 */
const USER = 1;
const CASH = 66;
const PAMP = 47; // cotiza a $925,85
const UNQUOTED = 3; // sin precio de mercado

const instrument = (id: number, ticker: string, type = 'ACCIONES'): QuotedInstrument => ({
  id,
  ticker,
  name: ticker,
  type,
  quote: null,
});

interface Scenario {
  book: InMemoryOrderBook;
  prices: InMemoryMarketPrices;
  log: RecordingLogger;
  placeOrder: PlaceOrder;
  cancelOrder: CancelOrder;
}

function scenario(orders?: Pick<OrderStore, 'findByIdempotencyKey'>): Scenario {
  const book = new InMemoryOrderBook();
  const prices = new InMemoryMarketPrices({ [PAMP]: 92585n });
  const placeOrder = new PlaceOrder({
    users: new InMemoryUsers([USER]),
    instruments: new InMemoryInstruments([
      instrument(PAMP, 'PAMP'),
      instrument(UNQUOTED, 'PGR'),
      instrument(CASH, 'ARS', 'MONEDA'),
    ]),
    marketPrices: prices,
    orders: orders ?? book,
    unitOfWork: book,
    cashInstrumentId: CASH,
  });
  const cancelOrder = new CancelOrder({ orders: book, unitOfWork: book, cashInstrumentId: CASH });
  return { book, prices, log: new RecordingLogger(), placeOrder, cancelOrder };
}

const command = (overrides: Partial<PlaceOrderCommand> = {}): PlaceOrderCommand => ({
  userId: USER,
  idempotencyKey: 'key-0001',
  instrumentId: PAMP,
  side: 'BUY',
  type: 'MARKET',
  size: 2,
  ...overrides,
});

const limitBuy = (overrides: Partial<PlaceOrderCommand> = {}): PlaceOrderCommand =>
  command({ type: 'LIMIT', price: 90000n, ...overrides });

describe('PlaceOrder', () => {
  let s: Scenario;
  beforeEach(() => {
    s = scenario();
  });

  describe('qué graba y qué mueve', () => {
    it('MARKET con saldo: graba FILLED al último close e intercambia pesos por acciones', async () => {
      s.book.give(USER, CASH, '2000');

      const { order, replayed } = await s.placeOrder.execute(command(), s.log);

      assert.equal(replayed, false);
      assert.equal(order.status, 'FILLED');
      assert.equal(order.price, 92585n);
      assert.equal(order.size, 2);
      assert.equal(order.rejectionReason, null);
      assert.deepEqual(s.book.balanceOf(USER, CASH), { available: '148.30', reserved: '0.00' });
      assert.deepEqual(s.book.balanceOf(USER, PAMP), { available: '2.00', reserved: '0.00' });
    });

    it('MARKET sin saldo: graba REJECTED con el motivo y no mueve nada', async () => {
      s.book.give(USER, CASH, '1851.69'); // falta un centavo para 2 × 925,85

      const { order } = await s.placeOrder.execute(command(), s.log);

      assert.equal(order.status, 'REJECTED');
      assert.equal(order.rejectionReason, 'INSUFFICIENT_FUNDS');
      assert.deepEqual(s.book.balanceOf(USER, CASH), { available: '1851.69', reserved: '0.00' });
      assert.deepEqual(s.book.balanceOf(USER, PAMP), { available: '0.00', reserved: '0.00' });
      assert.equal(s.book.allOrders().length, 1);
    });

    it('LIMIT con saldo: graba NEW y aparta los pesos sin entregar acciones', async () => {
      s.book.give(USER, CASH, '2000');

      const { order } = await s.placeOrder.execute(limitBuy(), s.log);

      assert.equal(order.status, 'NEW');
      assert.equal(order.price, 90000n);
      assert.deepEqual(s.book.balanceOf(USER, CASH), { available: '200.00', reserved: '1800.00' });
      assert.deepEqual(s.book.balanceOf(USER, PAMP), { available: '0.00', reserved: '0.00' });
    });

    it('venta MARKET: entrega acciones y recibe pesos', async () => {
      s.book.give(USER, PAMP, '5');

      const { order } = await s.placeOrder.execute(command({ side: 'SELL', size: 3 }), s.log);

      assert.equal(order.status, 'FILLED');
      assert.deepEqual(s.book.balanceOf(USER, PAMP), { available: '2.00', reserved: '0.00' });
      assert.deepEqual(s.book.balanceOf(USER, CASH), { available: '2777.55', reserved: '0.00' });
    });

    it('venta LIMIT sin acciones suficientes: REJECTED por falta de acciones', async () => {
      s.book.give(USER, PAMP, '2');

      const { order } = await s.placeOrder.execute(
        command({ side: 'SELL', type: 'LIMIT', size: 3, price: 100000n }),
        s.log,
      );

      assert.equal(order.status, 'REJECTED');
      assert.equal(order.rejectionReason, 'INSUFFICIENT_SHARES');
      assert.deepEqual(s.book.balanceOf(USER, PAMP), { available: '2.00', reserved: '0.00' });
    });

    it('por monto: la cantidad sale del precio que corresponde al tipo de orden', async () => {
      s.book.give(USER, CASH, '10000');

      const market = await s.placeOrder.execute(
        command({ size: undefined, amount: 500000n }),
        s.log,
      );
      const limit = await s.placeOrder.execute(
        limitBuy({ idempotencyKey: 'key-0002', size: undefined, amount: 500000n, price: 40000n }),
        s.log,
      );

      assert.equal(market.order.size, 5); // 5000 / 925,85
      assert.equal(limit.order.size, 12); // 5000 / 400
    });

    it('una LIMIT no consulta el precio de mercado; una MARKET lo consulta una vez', async () => {
      s.book.give(USER, CASH, '5000');

      await s.placeOrder.execute(limitBuy(), s.log);
      assert.equal(s.prices.lookups, 0);

      await s.placeOrder.execute(command({ idempotencyKey: 'key-0002' }), s.log);
      assert.equal(s.prices.lookups, 1);
    });

    it('una LIMIT se puede dejar sobre un instrumento sin precio de mercado', async () => {
      s.book.give(USER, CASH, '5000');
      const { order } = await s.placeOrder.execute(limitBuy({ instrumentId: UNQUOTED }), s.log);
      assert.equal(order.status, 'NEW');
    });
  });

  describe('valida todo antes de escribir', () => {
    const invalid: Array<[string, Partial<PlaceOrderCommand>, new (...args: never[]) => Error]> = [
      ['size y amount juntos', { amount: 1000n }, InvalidOrderError],
      ['ni size ni amount', { size: undefined }, InvalidOrderError],
      ['MARKET con precio', { price: 1000n }, InvalidOrderError],
      ['LIMIT sin precio', { type: 'LIMIT' }, InvalidOrderError],
      ['usuario inexistente', { userId: 999 }, UserNotFoundError],
      ['instrumento inexistente', { instrumentId: 999 }, InstrumentNotFoundError],
      ['instrumento no operable', { instrumentId: CASH }, InstrumentNotTradableError],
      ['MARKET sin precio de mercado', { instrumentId: UNQUOTED }, MarketPriceUnavailableError],
      ['monto menor al precio', { size: undefined, amount: 92584n }, AmountBelowUnitPriceError],
    ];

    for (const [name, overrides, expectedError] of invalid) {
      it(`${name}: falla sin abrir una unidad de trabajo ni dejar rastro`, async () => {
        s.book.give(USER, CASH, '100000');

        await assert.rejects(s.placeOrder.execute(command(overrides), s.log), expectedError);

        assert.equal(s.book.unitsOfWork, 0);
        assert.equal(s.book.allOrders().length, 0);
        assert.deepEqual(s.book.balanceOf(USER, CASH), {
          available: '100000.00',
          reserved: '0.00',
        });
        assert.deepEqual(s.log.entries, []);
      });
    }
  });

  describe('idempotencia', () => {
    it('la misma key con el mismo pedido devuelve la orden original sin escribir de nuevo', async () => {
      s.book.give(USER, CASH, '5000');
      const first = await s.placeOrder.execute(command(), s.log);

      const second = await s.placeOrder.execute(command(), s.log);

      assert.equal(second.replayed, true);
      assert.deepEqual(second.order, first.order);
      assert.equal(s.book.unitsOfWork, 1);
      assert.equal(s.book.allOrders().length, 1);
      assert.deepEqual(s.book.balanceOf(USER, CASH), { available: '3148.30', reserved: '0.00' });
    });

    it('un reintento no vuelve a valuar: devuelve lo grabado sin consultar precios', async () => {
      // La respuesta de una key ya usada es la orden grabada, no una nueva evaluación.
      s.book.give(USER, CASH, '5000');
      const first = await s.placeOrder.execute(command(), s.log);
      const lookupsBefore = s.prices.lookups;

      const second = await s.placeOrder.execute(command(), s.log);

      assert.equal(second.order.id, first.order.id);
      assert.equal(s.prices.lookups, lookupsBefore);
    });

    it('la misma key con otro pedido es un error del cliente', async () => {
      s.book.give(USER, CASH, '5000');
      await s.placeOrder.execute(command(), s.log);

      await assert.rejects(
        s.placeOrder.execute(command({ size: 3 }), s.log),
        (error: unknown) =>
          error instanceof IdempotencyKeyReuseError && error.details?.orderId === 1,
      );
      assert.equal(s.book.allOrders().length, 1);
    });

    /**
     * La carrera real: dos pedidos con la misma key pasan juntos el chequeo previo (ninguno
     * ve la orden del otro) y recién chocan al grabar. Se simula con un lector que la
     * primera vez no encuentra la orden que ya existe.
     */
    function racing(book: InMemoryOrderBook): Pick<OrderStore, 'findByIdempotencyKey'> {
      let missed = false;
      return {
        findByIdempotencyKey(userId, key) {
          if (!missed) {
            missed = true;
            return Promise.resolve(null);
          }
          return book.findByIdempotencyKey(userId, key);
        },
      };
    }

    function loserOf(winner: Scenario): PlaceOrder {
      return new PlaceOrder({
        users: new InMemoryUsers([USER]),
        instruments: new InMemoryInstruments([instrument(PAMP, 'PAMP')]),
        marketPrices: winner.prices,
        orders: racing(winner.book),
        unitOfWork: winner.book,
        cashInstrumentId: CASH,
      });
    }

    it('si pierde la carrera por la key, deshace su reserva y devuelve la orden ganadora', async () => {
      const winner = scenario();
      winner.book.give(USER, CASH, '5000');
      const first = await winner.placeOrder.execute(command(), winner.log);
      const afterWinner = winner.book.balanceOf(USER, CASH);

      const log = new RecordingLogger();
      const second = await loserOf(winner).execute(command(), log);

      assert.equal(second.replayed, true);
      assert.equal(second.order.id, first.order.id);
      assert.equal(winner.book.unitsOfWork, 2); // el perdedor llegó a abrir la suya
      assert.equal(winner.book.allOrders().length, 1);
      // Si la reserva del perdedor no se deshiciera, habría $1.851,70 menos.
      assert.deepEqual(winner.book.balanceOf(USER, CASH), afterWinner);
      assert.deepEqual(log.events(), ['order.replayed']);
    });

    it('si pierde la carrera con un pedido distinto, falla sin dejar su reserva', async () => {
      const winner = scenario();
      winner.book.give(USER, CASH, '5000');
      await winner.placeOrder.execute(command(), winner.log);
      const afterWinner = winner.book.balanceOf(USER, CASH);

      await assert.rejects(
        loserOf(winner).execute(command({ size: 1 }), new RecordingLogger()),
        IdempotencyKeyReuseError,
      );
      assert.deepEqual(winner.book.balanceOf(USER, CASH), afterWinner);
      assert.equal(winner.book.allOrders().length, 1);
    });

    it('una key duplicada sin orden asociada es una invariante rota, no se disimula', async () => {
      const book = new InMemoryOrderBook();
      book.give(USER, CASH, '5000');
      const placeOrder = new PlaceOrder({
        users: new InMemoryUsers([USER]),
        instruments: new InMemoryInstruments([instrument(PAMP, 'PAMP')]),
        marketPrices: new InMemoryMarketPrices({ [PAMP]: 92585n }),
        orders: { findByIdempotencyKey: () => Promise.resolve(null) }, // nunca la encuentra
        unitOfWork: book,
        cashInstrumentId: CASH,
      });
      await placeOrder.execute(command(), new RecordingLogger());

      await assert.rejects(
        placeOrder.execute(command(), new RecordingLogger()),
        InvariantViolationError,
      );
    });
  });

  describe('fallas', () => {
    it('si falla la grabación de la orden, el error se propaga y el saldo vuelve a como estaba', async () => {
      s.book.give(USER, CASH, '5000');
      s.book.failNextInsertWith = new Error('disco lleno');

      await assert.rejects(s.placeOrder.execute(command(), s.log), /disco lleno/);

      assert.deepEqual(s.book.balanceOf(USER, CASH), { available: '5000.00', reserved: '0.00' });
      assert.deepEqual(s.book.balanceOf(USER, PAMP), { available: '0.00', reserved: '0.00' });
      assert.equal(s.book.allOrders().length, 0);
      assert.deepEqual(s.log.entries, []); // no se registra una orden que no existe
    });

    it('después de una falla, el mismo pedido con la misma key funciona', async () => {
      s.book.give(USER, CASH, '5000');
      s.book.failNextInsertWith = new Error('disco lleno');
      await assert.rejects(s.placeOrder.execute(command(), s.log));

      const { order, replayed } = await s.placeOrder.execute(command(), s.log);

      assert.equal(replayed, false);
      assert.equal(order.status, 'FILLED');
    });
  });

  describe('log de negocio', () => {
    it('una orden aceptada deja order.placed con sus datos', async () => {
      s.book.give(USER, CASH, '5000');
      await s.placeOrder.execute(command(), s.log);

      assert.deepEqual(s.log.entries, [
        {
          level: 'info',
          message: 'Orden registrada',
          fields: {
            event: 'order.placed',
            orderId: 1,
            userId: USER,
            instrumentId: PAMP,
            side: 'BUY',
            type: 'MARKET',
            status: 'FILLED',
            size: 2,
            price: '925.85',
          },
        },
      ]);
    });

    it('un rechazo deja order.rejected, como advertencia y con el motivo', async () => {
      await s.placeOrder.execute(command(), s.log);

      const [entry] = s.log.entries;
      assert.equal(entry?.level, 'warn');
      assert.equal(entry?.fields.event, 'order.rejected');
      assert.equal(entry?.fields.reason, 'INSUFFICIENT_FUNDS');
      assert.equal(entry?.fields.status, 'REJECTED');
    });

    it('un reintento deja order.replayed y no vuelve a registrar la orden', async () => {
      s.book.give(USER, CASH, '5000');
      await s.placeOrder.execute(command(), s.log);
      await s.placeOrder.execute(command(), s.log);

      assert.deepEqual(s.log.events(), ['order.placed', 'order.replayed']);
      assert.deepEqual(s.log.entries[1]?.fields, {
        event: 'order.replayed',
        orderId: 1,
        userId: USER,
      });
    });
  });
});

describe('CancelOrder', () => {
  let s: Scenario;
  beforeEach(() => {
    s = scenario();
  });

  it('cancela una LIMIT de compra en NEW y devuelve los pesos reservados', async () => {
    s.book.give(USER, CASH, '2000');
    const { order } = await s.placeOrder.execute(limitBuy(), s.log);

    const result = await s.cancelOrder.execute({ userId: USER, orderId: order.id }, s.log);

    assert.equal(result.alreadyCancelled, false);
    assert.equal(result.order.status, 'CANCELLED');
    assert.deepEqual(s.book.balanceOf(USER, CASH), { available: '2000.00', reserved: '0.00' });
    assert.deepEqual(s.log.events(), ['order.placed', 'order.cancelled']);
  });

  it('cancela una LIMIT de venta en NEW y devuelve las acciones reservadas', async () => {
    s.book.give(USER, PAMP, '10');
    const { order } = await s.placeOrder.execute(
      command({ side: 'SELL', type: 'LIMIT', size: 4, price: 100000n }),
      s.log,
    );
    assert.deepEqual(s.book.balanceOf(USER, PAMP), { available: '6.00', reserved: '4.00' });

    await s.cancelOrder.execute({ userId: USER, orderId: order.id }, s.log);

    assert.deepEqual(s.book.balanceOf(USER, PAMP), { available: '10.00', reserved: '0.00' });
    assert.deepEqual(s.book.balanceOf(USER, CASH), { available: '0.00', reserved: '0.00' });
  });

  it('cancelar de nuevo no libera otra vez: avisa que ya estaba cancelada', async () => {
    s.book.give(USER, CASH, '2000');
    const { order } = await s.placeOrder.execute(limitBuy(), s.log);
    await s.cancelOrder.execute({ userId: USER, orderId: order.id }, s.log);

    const again = await s.cancelOrder.execute({ userId: USER, orderId: order.id }, s.log);

    assert.equal(again.alreadyCancelled, true);
    assert.equal(again.order.status, 'CANCELLED');
    assert.deepEqual(s.book.balanceOf(USER, CASH), { available: '2000.00', reserved: '0.00' });
    assert.deepEqual(s.log.events(), ['order.placed', 'order.cancelled', 'order.cancel_repeated']);
  });

  for (const [name, setup] of [
    ['FILLED', (book: InMemoryOrderBook) => book.give(USER, CASH, '5000')],
    ['REJECTED', (_book: InMemoryOrderBook) => {}],
  ] as const) {
    it(`una orden ${name} no se cancela y el error dice en qué estado está`, async () => {
      setup(s.book);
      const { order } = await s.placeOrder.execute(command(), s.log);
      assert.equal(order.status, name);
      const before = s.book.balanceOf(USER, CASH);

      await assert.rejects(
        s.cancelOrder.execute({ userId: USER, orderId: order.id }, s.log),
        (error: unknown) =>
          error instanceof OrderNotCancellableError && error.details?.status === name,
      );
      assert.deepEqual(s.book.balanceOf(USER, CASH), before);
      assert.equal(s.book.allOrders()[0]?.status, name);
    });
  }

  it('una orden que no existe, o que es de otro usuario, no se encuentra', async () => {
    s.book.give(USER, CASH, '2000');
    const { order } = await s.placeOrder.execute(limitBuy(), s.log);

    await assert.rejects(
      s.cancelOrder.execute({ userId: USER, orderId: 999 }, s.log),
      OrderNotFoundError,
    );
    await assert.rejects(
      s.cancelOrder.execute({ userId: 2, orderId: order.id }, s.log),
      OrderNotFoundError,
    );
    assert.equal(s.book.allOrders()[0]?.status, 'NEW');
  });

  it('si no se puede devolver la reserva, la orden no queda cancelada', async () => {
    // Cambio de estado y devolución van en la misma unidad de trabajo: o las dos o ninguna.
    s.book.give(USER, CASH, '2000');
    const { order } = await s.placeOrder.execute(limitBuy(), s.log);
    s.book.give(USER, CASH, '200', '0'); // la reserva "desaparece": estado inconsistente

    await assert.rejects(
      s.cancelOrder.execute({ userId: USER, orderId: order.id }, s.log),
      InvariantViolationError,
    );
    assert.equal(s.book.allOrders()[0]?.status, 'NEW');
  });
});
