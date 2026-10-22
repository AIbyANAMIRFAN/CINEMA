import { describe, expect, it } from "vitest";
import {
  SERVICE_FEE_PER_SEAT_MINOR,
  TAX_RATE_BPS,
  calculateTotals,
  formatMoney,
  seatPrice,
} from "@/lib/pricing";

describe("seatPrice", () => {
  it("applies seat-type multipliers in integer minor units", () => {
    expect(seatPrice(1000, "STANDARD")).toBe(1000);
    expect(seatPrice(1000, "ACCESSIBLE")).toBe(1000);
    expect(seatPrice(1000, "PREMIUM")).toBe(1400);
    expect(seatPrice(0, "PREMIUM")).toBe(0);
  });

  it("rounds half up", () => {
    // 1251 * 1.4 = 1751.4 -> 1751 ; 1250.5 impossible; 1125 * 1.4 = 1575 ; 1001 * 1.4 = 1401.4 -> 1401
    expect(seatPrice(1251, "PREMIUM")).toBe(1751);
    // 1 * 1.4 = 1.4 -> 1 ; 5 * 1.4 = 7 ; 25 * 1.4 = 35 ; 3 * 1.4 = 4.2 -> 4 ; 15*1.4=21;
    expect(seatPrice(1, "PREMIUM")).toBe(1);
    // 0.5 boundaries: 1.4 * x = n + 0.5 when x = 5k+... e.g. x=... 1.4*x has fractional .5 never (multiple of 0.2). Use 2.5 ->
    // check against exact rational rounding for a range.
    for (let base = 0; base < 5000; base += 7) {
      const exact = (base * 140) / 100;
      expect(seatPrice(base, "PREMIUM")).toBe(Math.floor(exact + 0.5));
      expect(Number.isInteger(seatPrice(base, "PREMIUM"))).toBe(true);
    }
  });

  it("rejects negative or fractional base prices", () => {
    expect(() => seatPrice(-1, "STANDARD")).toThrow();
    expect(() => seatPrice(10.5, "STANDARD")).toThrow();
    expect(() => seatPrice(Number.NaN, "STANDARD")).toThrow();
  });
});

describe("calculateTotals", () => {
  it("adds a per-seat fee and 8% tax on subtotal + fees", () => {
    expect(SERVICE_FEE_PER_SEAT_MINOR).toBe(150);
    expect(TAX_RATE_BPS).toBe(800);
    const t = calculateTotals([1250, 1250, 1750]);
    expect(t.subtotalMinor).toBe(4250);
    expect(t.feeMinor).toBe(450);
    // (4250 + 450) * 0.08 = 376
    expect(t.taxMinor).toBe(376);
    expect(t.totalMinor).toBe(4250 + 450 + 376);
  });

  it("rounds tax half up (to the nearest cent)", () => {
    // subtotal 1000 + fee 150 = 1150 -> 92.0
    expect(calculateTotals([1000]).taxMinor).toBe(92);
    // 1006 + 150 = 1156 * 0.08 = 92.48 -> 92
    expect(calculateTotals([1006]).taxMinor).toBe(92);
    // 1012 + 150 = 1162 * .08 = 92.96 -> 93
    expect(calculateTotals([1012]).taxMinor).toBe(93);
    // exactly .5: 1162.5? need (s+f)*8 % 100 == 50 -> s+f = 1156.25 impossible; s+f = 1031.25 no.
    // (s+f)*800/10000 = x.5 <=> (s+f)*8 = 100k + 50 -> (s+f) = (100k+50)/8 -> needs integer: 100k+50 divisible by 8? 150/8 no, 250 no, 350 no, 450 no...
    // 100k+50 = 2*(50k+25) -> never divisible by 8. So exact .5 never occurs with 8%; verify formula over a range instead.
    for (let s = 0; s < 20000; s += 13) {
      const t = calculateTotals([s]);
      const exact = ((s + 150) * 8) / 100;
      expect(t.taxMinor).toBe(Math.floor(exact + 0.5));
      expect(t.totalMinor).toBe(t.subtotalMinor + t.feeMinor + t.taxMinor);
    }
  });

  it("returns integers only and never floats", () => {
    const t = calculateTotals([1, 3, 7, 999, 1751]);
    for (const v of Object.values(t)) expect(Number.isInteger(v)).toBe(true);
    // classic float pitfall: 0.1 + 0.2 style amounts stay exact
    expect(calculateTotals([10, 20]).subtotalMinor).toBe(30);
  });

  it("handles empty and rejects invalid prices", () => {
    expect(calculateTotals([])).toEqual({ subtotalMinor: 0, feeMinor: 0, taxMinor: 0, totalMinor: 0 });
    expect(() => calculateTotals([-1])).toThrow();
    expect(() => calculateTotals([1.5])).toThrow();
  });

  it("formats money for display only", () => {
    expect(formatMoney(4626)).toBe("$46.26");
  });
});
