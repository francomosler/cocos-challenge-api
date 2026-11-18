-- 001: integridad e índices sobre el esquema provisto.
-- No cambia el significado de ninguna columna; solo impide datos inválidos y evita
-- recorridos completos de tabla. La justificación de cada punto está en docs/base-de-datos.md.

-- orders: toda orden tiene dueño, instrumento, cantidad, precio, tipo, lado, estado y fecha.
ALTER TABLE orders
  ALTER COLUMN instrumentid SET NOT NULL,
  ALTER COLUMN userid       SET NOT NULL,
  ALTER COLUMN size         SET NOT NULL,
  ALTER COLUMN price        SET NOT NULL,
  ALTER COLUMN type         SET NOT NULL,
  ALTER COLUMN side         SET NOT NULL,
  ALTER COLUMN status       SET NOT NULL,
  ALTER COLUMN datetime     SET NOT NULL,
  ADD CONSTRAINT orders_side_check   CHECK (side IN ('BUY', 'SELL', 'CASH_IN', 'CASH_OUT')),
  ADD CONSTRAINT orders_type_check   CHECK (type IN ('MARKET', 'LIMIT')),
  ADD CONSTRAINT orders_status_check CHECK (status IN ('NEW', 'FILLED', 'REJECTED', 'CANCELLED')),
  ADD CONSTRAINT orders_size_check   CHECK (size > 0),
  ADD CONSTRAINT orders_price_check  CHECK (price > 0);

-- instruments: el ticker identifica al activo; no puede faltar ni repetirse.
ALTER TABLE instruments
  ALTER COLUMN ticker SET NOT NULL,
  ALTER COLUMN name   SET NOT NULL,
  ALTER COLUMN type   SET NOT NULL,
  ADD CONSTRAINT instruments_ticker_key UNIQUE (ticker);

-- marketdata: un solo precio por instrumento y día. El índice de esta restricción
-- también resuelve "último precio de un instrumento" recorriéndolo hacia atrás.
ALTER TABLE marketdata
  ALTER COLUMN instrumentid SET NOT NULL,
  ALTER COLUMN date         SET NOT NULL,
  ADD CONSTRAINT marketdata_instrument_date_key UNIQUE (instrumentid, date);

-- Todas las lecturas de órdenes de la API son "las de un usuario en ciertos estados".
CREATE INDEX orders_user_status_idx ON orders (userid, status);
