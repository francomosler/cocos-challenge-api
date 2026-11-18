import type { Cents } from '../../shared/money.ts';

/** Fuente de precios de mercado. Hoy es la tabla `marketdata`; podría ser un proveedor externo. */
export interface MarketPrices {
  /** `close` más reciente del instrumento, o `null` si nunca cotizó. */
  latestClose(instrumentId: number): Promise<Cents | null>;
}
