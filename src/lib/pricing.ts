// All amounts are integer minor units (cents). Never use floats for money.

export const SERVICE_FEE_PER_SEAT_MINOR = 150;
/** Sales tax in basis points (800 = 8.00%), applied to tickets plus service fees. */
export const TAX_RATE_BPS = 800;
export const MAX_SEATS_PER_BOOKING = 10;
export const HOLD_MINUTES = 10;
/** Stripe Checkout sessions must live at least 30 minutes, so the hold is extended to cover it. */
export const CHECKOUT_SESSION_MINUTES = 30;
export const CHECKOUT_HOLD_GRACE_MINUTES = 2;
/** Confirmed bookings can be cancelled (and refunded) until this long before the show. */
export const CANCELLATION_CUTOFF_MINUTES = 120;

export const SEAT_TYPE_MULTIPLIER_PCT = {
  STANDARD: 100,
  PREMIUM: 140,
  ACCESSIBLE: 100,
} as const;

export type SeatTypeName = keyof typeof SEAT_TYPE_MULTIPLIER_PCT;

/** Integer division rounding half away from zero, for non-negative inputs. */
function divRound(numerator: number, denominator: number) {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

export function seatPrice(basePriceMinor: number, type: SeatTypeName) {
  if (!Number.isSafeInteger(basePriceMinor) || basePriceMinor < 0) {
    throw new Error("basePriceMinor must be a non-negative integer");
  }
  return divRound(basePriceMinor * SEAT_TYPE_MULTIPLIER_PCT[type], 100);
}

export type PriceBreakdown = {
  subtotalMinor: number;
  feeMinor: number;
  taxMinor: number;
  totalMinor: number;
};

export function calculateTotals(seatPricesMinor: number[]): PriceBreakdown {
  for (const p of seatPricesMinor) {
    if (!Number.isSafeInteger(p) || p < 0) throw new Error("seat prices must be non-negative integers");
  }
  const subtotalMinor = seatPricesMinor.reduce((a, b) => a + b, 0);
  const feeMinor = SERVICE_FEE_PER_SEAT_MINOR * seatPricesMinor.length;
  const taxMinor = divRound((subtotalMinor + feeMinor) * TAX_RATE_BPS, 10_000);
  return { subtotalMinor, feeMinor, taxMinor, totalMinor: subtotalMinor + feeMinor + taxMinor };
}

export function formatMoney(minor: number, currency = "USD", locale = "en-US") {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
}
