-- 003: metadatos de la orden para idempotencia y motivo de rechazo.

ALTER TABLE orders
  -- Identificador de la intención de operar, generado por el cliente (uno por compra o venta).
  ADD COLUMN idempotency_key  VARCHAR(64),
  -- SHA-256 del pedido original: permite detectar la misma key con un cuerpo distinto.
  ADD COLUMN request_hash     CHAR(64),
  -- Por qué quedó REJECTED (INSUFFICIENT_FUNDS, INSUFFICIENT_SHARES).
  ADD COLUMN rejection_reason VARCHAR(40);

-- Una intención produce, como mucho, una orden. La garantía vive en la base, así que
-- vale aunque se reinicie la API o el reintento caiga en otra instancia.
-- Las órdenes históricas no tienen key y quedan fuera del índice.
CREATE UNIQUE INDEX orders_user_idempotency_key_idx
  ON orders (userid, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
