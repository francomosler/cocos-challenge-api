-- 002: saldos por cuenta y activo.
--
-- `orders` sigue siendo la fuente de verdad. `balances` es una proyección que se
-- actualiza en la misma transacción que cada orden y existe para poder autorizar una
-- orden con un único UPDATE condicional (sin sumar el historial y sin leer-y-escribir).
--
--   available: lo que la cuenta puede comprometer ahora.
--   reserved:  lo comprometido por órdenes LIMIT en estado NEW.
--
-- Los pesos son la fila del instrumento ARS (tipo MONEDA), igual que en `orders`.
-- Para pesos el valor es un importe; para acciones, una cantidad entera.

CREATE TABLE balances (
  userid       INT            NOT NULL REFERENCES users (id),
  instrumentid INT            NOT NULL REFERENCES instruments (id),
  available    NUMERIC(20, 2) NOT NULL DEFAULT 0,
  reserved     NUMERIC(20, 2) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (userid, instrumentid),
  CONSTRAINT balances_reserved_check CHECK (reserved >= 0)
  -- Sin CHECK (available >= 0): los datos provistos traen una posición sobrevendida
  -- (usuario 1, instrumento 31: compró 20 y vendió 30). La API nunca deja bajar de
  -- cero porque todo débito es condicional (WHERE available >= monto).
);

-- Carga inicial: se reconstruye cada saldo a partir de las órdenes existentes.
WITH cash AS (
  SELECT id FROM instruments WHERE ticker = 'ARS' AND type = 'MONEDA'
),
ledger AS (
  -- Pesos: entran con CASH_IN y ventas, salen con CASH_OUT y compras.
  SELECT
    o.userid,
    (SELECT id FROM cash) AS instrumentid,
    SUM(CASE
          WHEN o.status = 'FILLED' AND o.side IN ('CASH_IN', 'SELL')  THEN o.size * o.price
          WHEN o.status = 'FILLED' AND o.side IN ('CASH_OUT', 'BUY')  THEN -(o.size * o.price)
          ELSE 0
        END) AS total,
    SUM(CASE WHEN o.status = 'NEW' AND o.side = 'BUY' THEN o.size * o.price ELSE 0 END) AS reserved
  FROM orders o
  WHERE o.status IN ('FILLED', 'NEW')
  GROUP BY o.userid

  UNION ALL

  -- Acciones: suman las compras ejecutadas, restan las ventas ejecutadas.
  SELECT
    o.userid,
    o.instrumentid,
    SUM(CASE
          WHEN o.status = 'FILLED' AND o.side = 'BUY'  THEN o.size
          WHEN o.status = 'FILLED' AND o.side = 'SELL' THEN -o.size
          ELSE 0
        END) AS total,
    SUM(CASE WHEN o.status = 'NEW' AND o.side = 'SELL' THEN o.size ELSE 0 END) AS reserved
  FROM orders o
  WHERE o.side IN ('BUY', 'SELL') AND o.status IN ('FILLED', 'NEW')
  GROUP BY o.userid, o.instrumentid
)
INSERT INTO balances (userid, instrumentid, available, reserved)
SELECT userid, instrumentid, total - reserved, reserved
FROM ledger
WHERE total <> 0 OR reserved <> 0;

-- Toda cuenta tiene su fila de pesos, aunque esté en cero.
INSERT INTO balances (userid, instrumentid)
SELECT u.id, i.id
FROM users u
CROSS JOIN instruments i
WHERE i.ticker = 'ARS' AND i.type = 'MONEDA'
ON CONFLICT (userid, instrumentid) DO NOTHING;
