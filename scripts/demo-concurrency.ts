/**
 * Demo del escenario de doble gasto contra una API levantada (`npm run dev`).
 *
 * Manda 20 órdenes de compra al mismo tiempo, cada una por una parte importante del
 * saldo del usuario 1, y muestra cuántas se ejecutaron y cómo quedó el saldo.
 *
 *   npm run demo:concurrency
 *   API_URL=http://localhost:3000 USER_ID=1 npm run demo:concurrency
 */
import { randomUUID } from 'node:crypto';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const USER_ID = Number(process.env.USER_ID ?? 1);
const INSTRUMENT_ID = 47; // PAMP
const ORDERS = 20;

interface Portfolio {
  availableCash: number;
  reservedCash: number;
  totalAccountValue: number;
}

interface Order {
  id: number;
  status: string;
  size: number;
  total: number;
}

async function portfolio(): Promise<Portfolio> {
  const response = await fetch(`${API_URL}/users/${USER_ID}/portfolio`);
  if (!response.ok) throw new Error(`No se pudo leer el portfolio: HTTP ${response.status}`);
  return (await response.json()) as Portfolio;
}

async function buy(amount: number): Promise<Order> {
  const response = await fetch(`${API_URL}/users/${USER_ID}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ instrumentId: INSTRUMENT_ID, side: 'BUY', type: 'MARKET', amount }),
  });
  if (response.status !== 201) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Order;
}

const before = await portfolio();
// Cada orden pide el 15 % del saldo: entran 6 y la séptima ya no tiene con qué.
const amount = Math.floor(before.availableCash * 0.15);
if (amount < 1_000) {
  console.error(
    `El usuario ${USER_ID} casi no tiene pesos disponibles ($${before.availableCash}).`,
  );
  process.exit(1);
}

console.log(`Disponible antes: $${before.availableCash}`);
console.log(`Enviando ${ORDERS} compras simultáneas de hasta $${amount} cada una...`);

const orders = await Promise.all(Array.from({ length: ORDERS }, () => buy(amount)));
const filled = orders.filter((order) => order.status === 'FILLED');
const spent = filled.reduce((sum, order) => sum + order.total, 0);
const after = await portfolio();

console.log(`Ejecutadas: ${filled.length}   Rechazadas: ${orders.length - filled.length}`);
console.log(`Gastado: $${spent.toFixed(2)}`);
console.log(`Disponible después: $${after.availableCash}`);

const expected = Math.round((before.availableCash - spent) * 100) / 100;
const consistent = after.availableCash === expected && after.availableCash >= 0;
console.log(
  consistent ? 'OK: el saldo cierra y nunca quedó negativo.' : 'ERROR: el saldo no cierra.',
);
process.exit(consistent ? 0 : 1);
