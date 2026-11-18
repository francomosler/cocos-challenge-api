# Base de datos

Qué se cambió del esquema provisto, cómo se resolvió cada escritura y cada lectura, y qué mejoras harían falta en un ambiente productivo.

- La base se crea con el `database.sql` del challenge, sin modificarlo (`db/init/database.sql`). Los cambios se aplican encima como migraciones SQL versionadas (`db/migrations/`), con `npm run migrate`. Cada migración corre en una transacción y queda anotada en `schema_migrations`.
- No hay ORM. Todo el SQL está en los repositorios (`src/modules/*/*.repository.ts`), con parámetros. Los `UPDATE` condicionales y el orden de locks son el centro del diseño, y conviene verlos tal cual son.

## Resumen

| Problema | Qué se hizo | Sección |
|---|---|---|
| Dos órdenes simultáneas gastan el mismo saldo | Un `UPDATE` que descuenta solo si alcanza, sin leer antes | [2.1](#21-enviar-una-orden-sin-gastar-dos-veces-el-mismo-saldo) |
| Autorizar una orden cuesta más cuanto más historial tiene la cuenta | Tabla `balances`: una fila por cuenta y activo | [2.5](#25-por-qué-una-tabla-de-saldos-y-no-sumar-las-órdenes) |
| Varias órdenes pendientes comprometen el mismo saldo | Columnas `available` y `reserved` | [2.1](#21-enviar-una-orden-sin-gastar-dos-veces-el-mismo-saldo) |
| Una compra y una venta simultáneas se bloquean entre sí | La fila de pesos se toma siempre primero | [2.2](#22-compra-y-venta-simultáneas-sin-deadlock) |
| Un reintento crea una segunda orden | Índice único `(userid, idempotency_key)` | [2.3](#23-un-reintento-no-crea-otra-orden) |
| Varias cancelaciones devuelven la misma reserva | `UPDATE ... WHERE status = 'NEW'` | [2.4](#24-cancelar-libera-la-reserva-una-sola-vez) |
| El portfolio mezcla datos de antes y de después de una orden | Todas sus consultas ven la misma foto de la base | [3.1](#31-portfolio) |
| Consultas que recorren tablas enteras | Índices por usuario y estado, y por instrumento y fecha | [1](#1-cambios-al-esquema) |
| Datos inválidos en las tablas | `NOT NULL`, `CHECK` y `UNIQUE` | [1](#1-cambios-al-esquema) |
| Una cuenta ocupa todas las conexiones | Cola por cuenta y tope de pedidos en curso | [4.1](#41-una-cuenta-no-puede-quedarse-con-todas-las-conexiones) |
| Una espera sin fin | Límites de tiempo que terminan en `503` | [4.2](#42-ninguna-espera-es-indefinida) |

## 1. Cambios al esquema

Las tres migraciones son compatibles con los datos provistos.

### 001: integridad e índices

No cambia el significado de ninguna columna. Impide datos inválidos y evita recorrer tablas enteras.

| Cambio | Motivo |
|---|---|
| `NOT NULL` en `orders` (instrumento, usuario, cantidad, precio, tipo, lado, estado, fecha) | Una orden sin alguno de esos datos no se puede valuar ni atribuir. Los cálculos de saldo dejan de contemplar nulos |
| `CHECK` sobre `side`, `type` y `status` | Los valores válidos son los del enunciado. Un valor mal escrito (`"FILED"`) quedaría fuera de todos los cálculos sin que nadie lo note |
| `CHECK (size > 0)` y `CHECK (price > 0)` | Una orden por cero o con precio negativo invertiría el signo de un movimiento |
| `UNIQUE` en `instruments(ticker)` y `NOT NULL` en ticker, nombre y tipo | El ticker identifica al activo para el usuario; son los campos por los que se busca y se decide si es operable |
| `UNIQUE` en `marketdata(instrumentid, date)` | Un solo precio por instrumento y día. Su índice resuelve "último precio de un instrumento" |
| Índice `orders(userid, status)` | Todas las lecturas de órdenes de la API son "las de un usuario en ciertos estados" |

Con los datos del challenge (11 órdenes, 126 precios) Postgres lee las tablas enteras, porque a ese tamaño es lo más barato. Los índices empiezan a usarse cuando las tablas crecen; se comprobó con la base de prueba de la [sección 5](#5-mejoras-posibles-en-un-ambiente-productivo).

### 002: tabla `balances`

```sql
CREATE TABLE balances (
  userid       INT            NOT NULL REFERENCES users (id),
  instrumentid INT            NOT NULL REFERENCES instruments (id),
  available    NUMERIC(20, 2) NOT NULL DEFAULT 0,
  reserved     NUMERIC(20, 2) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (userid, instrumentid),
  CONSTRAINT balances_reserved_check CHECK (reserved >= 0)
);
```

- Una fila por cuenta y activo. Los pesos son la fila del instrumento ARS, como en `orders`, así que una sola tabla sirve para pesos y acciones.
- `available` es lo que se puede comprometer ahora y `reserved`, lo comprometido por órdenes `LIMIT` en `NEW`.
- La migración la carga desde las órdenes existentes. Toda cuenta recibe su fila de pesos, aunque esté en cero.
- No hay `CHECK (available >= 0)`: los datos provistos traen una posición sobrevendida (usuario 1, BMA: −10) y la carga inicial fallaría. La API nunca deja bajar de cero porque todo débito lleva la condición en el `WHERE`.

### 003: metadatos de la orden

| Columna | Motivo |
|---|---|
| `orders.idempotency_key` | Identificador de la intención de operar, que manda el cliente |
| `orders.request_hash` | Huella del pedido original, para detectar la misma key con un pedido distinto |
| `orders.rejection_reason` | Por qué quedó `REJECTED`. Sin esto, el usuario ve un rechazo sin explicación |

Más un índice único `(userid, idempotency_key)` para las órdenes que tienen key (ver [2.3](#23-un-reintento-no-crea-otra-orden)).

## 2. Escrituras

### 2.1 Enviar una orden sin gastar dos veces el mismo saldo

**Problema.** Una cuenta con $10.000 manda 20 órdenes a la vez. Si cada una lee el saldo, ve $10.000, decide que alcanza y después descuenta, se gasta varias veces la misma plata.

**Qué se hizo.** La API no lee el saldo para decidir. Intenta descontarlo con una sentencia que solo aplica si alcanza:

```sql
UPDATE balances
SET available = available - $monto
WHERE userid = $1 AND instrumentid = $2 AND available >= $monto
```

- Si afecta una fila, el saldo alcanzaba y ya quedó descontado. En la misma transacción se graba la orden como `FILLED`, o como `NEW` si es `LIMIT`.
- Si no afecta ninguna, la orden se graba como `REJECTED`, con el motivo en `rejection_reason`.

| Operación | Efecto sobre `balances` |
|---|---|
| `MARKET` de compra | Descuenta pesos si alcanzan; si alcanzaron, suma acciones |
| `MARKET` de venta | Descuenta acciones si alcanzan; si alcanzaron, suma pesos |
| `LIMIT` de compra | Pasa pesos de `available` a `reserved`, si alcanzan |
| `LIMIT` de venta | Pasa acciones de `available` a `reserved`, si alcanzan |
| Cancelar | Devuelve la reserva de `reserved` a `available` |

**Por qué.** Cuando dos transacciones quieren la misma fila, Postgres hace esperar a la segunda hasta que la primera confirme y vuelve a evaluar `available >= $monto` contra el valor nuevo. Nunca dos órdenes deciden sobre el mismo saldo, y no hace falta bloquear nada más:

- Validar el pedido, buscar el usuario y el instrumento, obtener el precio y chequear la idempotencia son lecturas sin locks.
- Lo único serializado es la fila de saldo de esa cuenta, durante dos a cuatro sentencias. Cuentas distintas no comparten ningún lock.
- No hay locks por instrumento: diez mil usuarios comprando la misma acción no compiten entre sí.

**Tests** (`test/functional/concurrency.test.ts`): "20 compras iguales con saldo para 7: se ejecutan exactamente 7", "20 compras de 20 acciones distintas: nunca se gasta más de lo que hay", "dos ventas MARKET de las mismas 100 acciones: se ejecuta una", "10 LIMIT que reservan el 60 % del saldo cada una: entra una sola". Fallan si el descuento se reemplaza por "leer el saldo y después restar".

### 2.2 Compra y venta simultáneas sin deadlock

**Problema.** Una compra `MARKET` toca primero la fila de pesos y después la del instrumento. Una venta, en su orden natural, haría lo contrario. Si la misma cuenta compra y vende el mismo activo a la vez, cada transacción toma una fila y espera la otra.

**Qué se hizo.** La fila de pesos se toma siempre primero. En una venta `MARKET` eso se hace explícito con un `SELECT ... FOR UPDATE` sobre la fila de pesos antes de descontar las acciones.

**Por qué.** Con un orden único no puede formarse un ciclo de esperas.

**Test.** "comprar y vender el mismo activo a la vez no produce deadlocks" manda 60 órdenes cruzadas y falla si se saca ese lock.

### 2.3 Un reintento no crea otra orden

**Problema.** La app parece no responder y el usuario toca "comprar" dos veces, o el cliente reintenta por un timeout. Solo el cliente sabe si dos pedidos son la misma intención.

**Qué se hizo.** El cliente manda un identificador por intención en el header `Idempotency-Key`. Se guarda en la orden, con un índice único:

```sql
CREATE UNIQUE INDEX orders_user_idempotency_key_idx
  ON orders (userid, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

- Antes de operar se busca la orden por key. Si existe, se devuelve sin operar de nuevo.
- Si dos pedidos con la misma key llegan a la vez, los dos pueden llegar a descontar saldo, pero al insertar la orden el índice frena al segundo. Su transacción se deshace entera, con el descuento incluido, y recibe la orden del primero.
- `request_hash` permite distinguir un reintento de un error: la misma key con otro pedido responde `422`.

**Por qué.** La garantía está en Postgres y no en memoria: vale aunque se reinicie la API o el reintento caiga en otra instancia. Va en la misma tabla, y no en una aparte, porque la orden y su key se confirman juntas en el mismo `INSERT`. Un rechazo también es definitivo: reintentar una orden `REJECTED` devuelve el mismo rechazo.

**Tests** (`test/functional/idempotency.test.ts`): "10 envíos simultáneos con la misma key crean una sola orden", "la garantía vale entre instancias: el reintento puede caer en otro pod", "la garantía sobrevive a un reinicio: la key está en la base, no en memoria".

### 2.4 Cancelar libera la reserva una sola vez

**Problema.** Si llegan diez cancelaciones de la misma orden, la reserva se tiene que devolver una sola vez.

**Qué se hizo.** La cancelación es un único `UPDATE` con el estado esperado en la condición:

```sql
UPDATE orders SET status = 'CANCELLED'
WHERE id = $1 AND userid = $2 AND status = 'NEW'
RETURNING ...
```

**Por qué.** Las diez esperan el lock de la fila y solo la primera la encuentra en `NEW`. Esa libera la reserva en la misma transacción; las demás reciben la orden ya cancelada, con `200`. El `userid` en la condición impide cancelar una orden ajena.

**Test.** "10 cancelaciones de la misma orden: una la cancela y la reserva se libera una vez".

### 2.5 Por qué una tabla de saldos y no sumar las órdenes

La alternativa era bloquear la cuenta, sumar todas sus órdenes, validar e insertar. Funciona, pero el trabajo bajo lock crece con el historial. Con `balances`, autorizar una orden cuesta lo mismo para una cuenta con 10 órdenes que para una con un millón.

El costo es mantener una proyección de `orders`, que sigue siendo la fuente de verdad. Se controla de tres formas:

- Se actualiza en la misma transacción que la orden: quedan las dos cosas o ninguna.
- `npm run reconcile` recalcula todo desde `orders` y avisa si hay diferencias.
- Cada test de concurrencia y cada test de propiedades termina con esa misma verificación.

Límite conocido: la proyección es correcta mientras toda escritura de `orders` pase por la API. Si otro sistema inserta órdenes directo en la tabla, `reconcile` detecta la diferencia pero no la corrige.

## 3. Lecturas

### 3.1 Portfolio

**Problema.** El enunciado pide calcular la tenencia y los pesos desde `orders`. Son varias consultas, y si entra una orden en el medio se mezclarían pesos de antes con acciones de después.

**Qué se hizo.**

- Tres consultas sobre `orders`, todas por usuario y estado: la suma de pesos, las operaciones ejecutadas en orden cronológico y las acciones reservadas por ventas pendientes. Para eso está el índice `orders(userid, status)`.
- Los precios de todas las posiciones se traen en una sola consulta.
- Todo corre en una transacción `REPEATABLE READ` de solo lectura: las consultas ven la misma foto de la base, no toman locks y no frenan ninguna orden.
- El costo promedio se calcula en código (`portfolio-calculator.ts`), recorriendo las operaciones en orden. Es una regla de negocio y queda fuera del SQL.

**Por qué desde `orders` y no desde `balances`.** Lo pide el enunciado, y `balances` no guarda el costo de cada posición. A cambio, el tiempo de respuesta crece con el historial de la cuenta (ver la mejora 2).

**Tests** (`test/functional/portfolio.test.ts`): "usuario 1: valor de la cuenta, pesos disponibles y posiciones", "compras a distinto precio promedian el costo y muestran ganancia o pérdida", "los pesos disponibles del portfolio (desde orders) coinciden con balances".

### 3.2 Último precio

Lo necesitan cada orden `MARKET`, la búsqueda y el portfolio:

```sql
SELECT close FROM marketdata
WHERE instrumentid = $1 AND close IS NOT NULL
ORDER BY date DESC
LIMIT 1
```

La restricción `UNIQUE (instrumentid, date)` de la migración 001 crea el índice que lo resuelve cuando la tabla crece: Postgres lo recorre hacia atrás y se queda con la primera fila, sin ordenar ni recorrer la tabla. Con 3 millones de precios tarda 0,03 ms.

### 3.3 Búsqueda

```sql
SELECT i.id, i.ticker, i.name, i.type, q.close, q.previousclose, q.date
FROM instruments i
LEFT JOIN LATERAL (/* último precio de i, como en 3.2 */) q ON true
WHERE i.type <> 'MONEDA' AND (i.ticker ILIKE $1 OR i.name ILIKE $1)
ORDER BY (upper(i.ticker) = upper($2)) DESC, (i.ticker ILIKE $3) DESC, i.ticker
LIMIT $4
```

- Busca el texto en cualquier parte del ticker o del nombre, sin distinguir mayúsculas.
- `%`, `_` y `\` se escapan: si el usuario los escribe, busca esos caracteres. Sin escaparlos, buscar `%` devolvería todo el mercado.
- Primero va el ticker exacto, después los tickers que empiezan con el texto y después el resto.
- El resultado está acotado: 20 por defecto y 100 como máximo.
- Los pesos (`MONEDA`) no aparecen, porque no son un activo operable.

Con 66 instrumentos, recorrer la tabla entera es lo más rápido. Con miles deja de serlo (ver la mejora 1).

**Tests** (`test/functional/instruments.test.ts`): "el ticker exacto va primero aunque otros también coincidan", "los comodines y símbolos se buscan literalmente: nunca devuelven de más", "ningún texto rompe la búsqueda: responde 200 o 400, nunca un error interno".

## 4. Conexiones y esperas

### 4.1 Una cuenta no puede quedarse con todas las conexiones

**Problema.** Los pedidos de una misma cuenta necesitan el lock de la misma fila, así que Postgres los atiende de a uno. Sin control, cada uno espera adentro de la base con una de las 10 conexiones de la instancia tomada. Una cuenta con muchos pedidos simultáneos (un cliente que reintenta, un bot, una operación colgada) deja esperando a todas las demás.

**Qué se hizo.** Dos barreras en memoria, que actúan antes de tocar la base (`src/shared/admission.ts`):

| | Cola por cuenta | Tope global |
|---|---|---|
| Qué limita | Pedidos de una misma cuenta | Pedidos en curso en la instancia |
| Valor por defecto | 2 trabajando y 20 esperando | 500 |
| Al superarlo | `429`, en el momento | `503`, en el momento |
| Espera | En memoria y por orden de llegada, hasta 2 s; después, `503` | No hay |
| A qué aplica | Órdenes, cancelaciones y portfolio | Lo anterior y la búsqueda |

**Por qué.** Esperar en memoria no ocupa una conexión. La cola no decide nada de negocio: quién se queda con el saldo lo sigue resolviendo el `UPDATE` condicional. Por eso puede ser de cada instancia y perderse en un reinicio sin consecuencias. Los rechazos llevan `Retry-After` y no consumen la `Idempotency-Key`.

Medido en una instancia, con pool de 10 conexiones y base local:

| Situación | Sin límites | Con cola y tope |
|---|---|---|
| Una cuenta manda 3.000 órdenes juntas: cuánto tarda la orden de otra cuenta | 2,2 s | 17 ms |
| El saldo de una cuenta queda retenido y esa cuenta reintenta 15 veces: orden de otra cuenta | 2,9 s | 3 ms |
| Ráfaga de 12.000 órdenes de 400 cuentas | Todas atendidas, mediana 3,3 s | 500 atendidas (mediana 0,45 s) y 11.500 con `503` (mediana 0,19 s) |

Los límites se cambian por variables de entorno; `.env.example` explica cada una.

**Tests** (`test/functional/admission.test.ts`): "una cuenta trabada ocupa 2 conexiones y las demás cuentas siguen operando", "con 2 trabajando y 20 esperando, el pedido 23 recibe 429 y se puede reintentar", "la cola es de cada instancia y no decide nada: con dos instancias el saldo se respeta igual".

### 4.2 Ninguna espera es indefinida

| Límite | Valor por defecto | Variable |
|---|---|---|
| Conexiones por instancia | 10 | `DB_POOL_MAX` |
| Espera por una conexión libre | 5 s | `DB_CONNECT_TIMEOUT_MS` |
| Espera por un lock de fila | 3 s | `DB_LOCK_TIMEOUT_MS` |
| Duración de una sentencia | 5 s | `DB_STATEMENT_TIMEOUT_MS` |

Vencido cualquiera de los tres tiempos, la transacción se deshace y la API responde `503` con `Retry-After`. Lo mismo pasa si Postgres detecta un deadlock. El motivo técnico (`lock_timeout`, `pool_timeout`, ...) queda en el log y no en la respuesta. Reintentar con la misma `Idempotency-Key` es seguro: nunca crea dos órdenes.

**Tests** (`test/functional/resilience.test.ts`): "si la fila de saldo está bloqueada demasiado tiempo → 503, sin orden; el reintento funciona", "si no hay conexiones libres → 503 con Retry-After, sin escribir nada".

## 5. Mejoras posibles en un ambiente productivo

No se aplicaron porque el challenge no las necesita. Las cifras salen de una prueba aparte, con una copia del esquema cargada con 100.000 instrumentos, 300.000 usuarios y 3,2 millones de órdenes en una máquina de desarrollo: valen como orden de magnitud. El SQL de esta sección se probó sobre los datos del challenge con las tres migraciones aplicadas.

Con ese volumen y sin cambiar nada, el envío de órdenes rinde igual que con la base chica (unas 2.500 por segundo en una instancia) y el portfolio de una cuenta típica tarda 2 ms. Lo que se degrada es la búsqueda y el portfolio de las cuentas con mucho historial.

### Con más volumen

| # | Mejora | Qué resuelve | Cuándo |
|---|---|---|---|
| 1 | Índice trigram y búsqueda en dos pasos | `ILIKE '%texto%'` recorre toda la tabla: 59 ms con 100.000 instrumentos. Con la mejora, 7 ms | Con miles de instrumentos |
| 2 | Costo de la posición en `balances` | El portfolio recorre las órdenes ejecutadas de la cuenta: 78 ms con 20.000 órdenes y 446 ms con 200.000. Leyendo `balances`, 0,3 ms | Con cuentas de miles de órdenes |
| 3 | `orders.id` de 64 bits | `SERIAL` se agota en 2.147 millones de filas: a 100 órdenes por segundo, en unos 8 meses | Cuanto antes: el cambio bloquea la tabla mientras la reescribe (9 s con 3,2 millones de filas) |
| 4 | Menos idas a la base por orden | Una compra `MARKET` hace 9. Guardando en memoria el usuario, el instrumento y el precio se pasa de 2.774 a 4.019 órdenes por segundo | Cuando el envío de órdenes sea el límite |
| 5 | Particionar `orders` por usuario | La tabla solo crece | Con cientos de millones de filas |
| 6 | Conciliar por lotes | `npm run reconcile` recalcula todo en una sentencia: tarda 2 s con 3,2 millones de órdenes y el límite por sentencia es de 5 s | Con varios millones de órdenes |
| 7 | `CHECK (available >= 0)` en `balances` | Segunda barrera contra saldos negativos, en la base | Después de corregir la posición sobrevendida de los datos provistos |
| 8 | `orders.datetime` con zona horaria | Hoy es `TIMESTAMP` sin zona y la API lo trata como UTC por convención | Si otros sistemas escriben la tabla |
| 9 | Unicidad en `users` | El email y el número de cuenta identifican a una persona | Al sumar alta de usuarios |
| 10 | Réplicas de lectura | El portfolio y la búsqueda son lecturas, y la mayor parte del tráfico | Cuando las lecturas compitan con las órdenes |
| 11 | PgBouncer delante de Postgres | Muchas instancias de la API con pocas conexiones reales | Al sumar instancias |
| 12 | Repartir las cuentas entre varias bases | Cada orden toca solo filas de una cuenta: se puede partir por usuario sin transacciones distribuidas | Cuando una sola base no alcance |

### Con un mercado real y otros servicios

El enunciado pide no simular el mercado, así que estos casos están diseñados pero no implementados.

| # | Mejora | Qué resuelve |
|---|---|---|
| 13 | Tabla `executions` y estados `PARTIALLY_FILLED` y `PENDING_CANCEL` | Ejecuciones parciales, y cancelar una orden mientras el mercado la ejecuta |
| 14 | Identificador propio enviado al broker y estado "envío incierto" | Que perder la respuesta del broker no termine en una orden duplicada |
| 15 | Tabla `outbox_events` | Avisar a otros servicios sin perder eventos |
| 16 | Cola durable por cuenta (Kafka, SQS FIFO) | Absorber picos procesando cada cuenta en orden. La API pasa a responder `202` y el resultado llega después |

### Detalle

**1. Búsqueda.**

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX instruments_search_trgm_idx
  ON instruments USING gin (ticker gin_trgm_ops, name gin_trgm_ops);
```

Con el índice, la consulta actual baja de 59 a 17 ms. El resto se gana eligiendo primero las 20 filas y buscando el precio solo de esas: hoy se busca el precio de todas las coincidencias antes de aplicar el `LIMIT`.

```sql
SELECT i.id, i.ticker, i.name, i.type, q.close, q.previousclose, q.date
FROM (
  SELECT id, ticker, name, type,
         (upper(ticker) = upper($2)) AS exact, (ticker ILIKE $3) AS prefix
  FROM instruments
  WHERE type <> 'MONEDA' AND (ticker ILIKE $1 OR name ILIKE $1)
  ORDER BY exact DESC, prefix DESC, ticker
  LIMIT $4
) i
LEFT JOIN LATERAL (/* último precio de i */) q ON true
ORDER BY i.exact DESC, i.prefix DESC, i.ticker;
```

Una búsqueda de una o dos letras no puede usar el índice, porque un trigrama necesita tres. Esas mejoran solo por la consulta en dos pasos: la de una letra pasa de 157 a 55 ms.

**2, 3, 7, 8 y 9. Cambios de una sentencia.**

```sql
-- 2. Costo de la posición
ALTER TABLE balances ADD COLUMN cost_basis NUMERIC(20, 2) NOT NULL DEFAULT 0;

-- 3. Identificador de 64 bits
ALTER TABLE orders ALTER COLUMN id TYPE BIGINT;
ALTER SEQUENCE orders_id_seq AS BIGINT;

-- 7. Saldo nunca negativo
ALTER TABLE balances ADD CONSTRAINT balances_available_check CHECK (available >= 0);

-- 8. Fecha con zona horaria
ALTER TABLE orders ALTER COLUMN datetime TYPE TIMESTAMPTZ USING datetime AT TIME ZONE 'UTC';

-- 9. Unicidad en usuarios
ALTER TABLE users
  ADD CONSTRAINT users_email_key UNIQUE (email),
  ADD CONSTRAINT users_accountnumber_key UNIQUE (accountnumber);
```

- **2.** El costo se actualizaría en la misma transacción que cada ejecución: una compra suma lo pagado y una venta resta en proporción a lo vendido, que es la regla que hoy aplica `portfolio-calculator.ts`. Con eso el portfolio se puede leer de `balances`. Antes hay que resolver el límite de la sección 2.5: que `balances` sea confiable aunque otro sistema escriba `orders`.
- **3 y 8.** Reescriben la tabla y piden un cambio chico en el repositorio de órdenes: leer el identificador como entero de 64 bits y grabar la fecha con `now()` en vez de convertirla a UTC a mano.
- **7.** Con los datos provistos falla, por la posición sobrevendida del usuario 1. Antes hay que corregir ese dato, por ejemplo con un movimiento de ajuste en `orders` que quede auditado.

**5. Particionado.**

```sql
CREATE TABLE orders_by_user (
  LIKE orders INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY (userid, id)
) PARTITION BY HASH (userid);

CREATE TABLE orders_by_user_0 PARTITION OF orders_by_user
  FOR VALUES WITH (MODULUS 8, REMAINDER 0);
-- ... y una partición por cada resto, hasta el 7

CREATE UNIQUE INDEX ON orders_by_user (userid, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Por fecha no se puede: Postgres exige que todo índice único de una tabla particionada incluya la clave de partición, y un índice `(userid, idempotency_key, datetime)` ya no garantizaría una orden por key. Por usuario sí, y además todas las consultas de la API filtran por `userid`. Es una migración por etapas: tabla nueva, copia por lotes y cambio de nombre.

**13. Ejecuciones parciales y cancelación pendiente.**

```sql
CREATE TABLE executions (
  id                  BIGSERIAL PRIMARY KEY,
  orderid             INT            NOT NULL REFERENCES orders (id),
  -- Identificador que asigna el mercado: si reenvía la ejecución, la restricción la descarta.
  market_execution_id VARCHAR(64)    NOT NULL UNIQUE,
  size                INT            NOT NULL CHECK (size > 0),
  price               NUMERIC(10, 2) NOT NULL CHECK (price > 0),
  executed_at         TIMESTAMPTZ    NOT NULL
);
CREATE INDEX executions_order_idx ON executions (orderid);

ALTER TABLE orders
  DROP CONSTRAINT orders_status_check,
  ADD CONSTRAINT orders_status_check CHECK (status IN
    ('NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL', 'FILLED', 'REJECTED', 'CANCELLED'));
```

- Lo ejecutado de una orden es la suma de sus ejecuciones. Cada una se aplica por sí misma, así que ni un duplicado ni un cambio en el orden de llegada alteran el resultado.
- Cada ejecución consume su parte de la reserva y acredita lo recibido, en la misma transacción en que se inserta.
- Cancelar pasa a ser un pedido: la orden queda en `PENDING_CANCEL`, la API responde `202` y el estado final lo decide el mercado. La reserva se libera recién cuando el mercado confirma.

**14. Respuesta del broker perdida.**

- La orden se graba y reserva saldo antes de enviarse: nunca hay una orden en el broker que la API no conozca.
- Al broker se le manda un identificador generado por la API. Es la misma idea que la `Idempotency-Key`, con la API en el rol de cliente.
- Un timeout no es un rechazo. La orden queda en "envío incierto" y, antes de reintentar, se consulta al broker por ese identificador.

**15. Outbox.**

```sql
CREATE TABLE outbox_events (
  id           BIGSERIAL PRIMARY KEY,
  event_id     UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  aggregate_id INT         NOT NULL,   -- la orden
  type         VARCHAR(50) NOT NULL,   -- order.filled, order.cancelled, ...
  payload      JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_pending_idx ON outbox_events (id) WHERE published_at IS NULL;

-- El proceso que publica toma un lote sin pisarse con otras instancias:
SELECT id, event_id, type, payload
FROM outbox_events
WHERE published_at IS NULL
ORDER BY id
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

El evento se inserta en la misma transacción que la orden: no existe la orden sin su evento. La entrega es "al menos una vez", y los consumidores descartan duplicados con `event_id`.
