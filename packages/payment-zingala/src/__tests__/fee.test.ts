import { describe, expect, it } from "vitest";
import type { PaymentError } from "@paid-tw/payment";
import {
  availablePeriods,
  calculateInstalmentPlan,
  findFeeOption,
  type ZingalaFeeSchedule,
} from "../fee.js";

async function caught(fn: () => unknown): Promise<PaymentError> {
  try {
    fn();
  } catch (e) {
    return e as PaymentError;
  }
  throw new Error("expected a throw");
}

describe("分期金額計算", () => {
  it("reproduces the manual's worked example exactly", () => {
    // Manual 1.1.14 p.33: 1000 元, consumer 負擔, 6 期, 每期利率 6%.
    // 總 = 1000 + round(1000 * 6/100) = 1060; 每期 = trunc(1060/6) = 176;
    // 首期 = 176 + (1060 - 176*6) = 180. The manual labels the middle step 四捨五入,
    // but 176 is only reachable by truncating — see fee.ts.
    const plan = calculateInstalmentPlan(1000, 6, 6);
    expect(plan.total).toBe(1060);
    expect(plan.each).toBe(176);
    expect(plan.first).toBe(180);
    expect(plan.interest).toBe(60);
  });

  it("truncates the per-period figure rather than rounding it", () => {
    // This is the whole reason the manual's example works out to 176: `round(1060/6)`
    // is 177. A Math.round implementation passes nothing here.
    expect(calculateInstalmentPlan(1000, 6, 6).each).toBe(176);
    expect(calculateInstalmentPlan(20_000, 12, 0).each).toBe(1666); // round would say 1667
    expect(calculateInstalmentPlan(20_000, 3, 0).each).toBe(6666); //  round would say 6667
  });

  it("puts the leftover dollars on the first instalment, never below 每期", () => {
    // Truncation cannot overshoot, so the residue is always >= 0.
    for (const periods of [1, 2, 3, 6, 7, 9, 12, 24]) {
      for (const amount of [1, 999, 1000, 20_000, 123_457]) {
        const p = calculateInstalmentPlan(amount, periods, 0);
        expect(p.first).toBeGreaterThanOrEqual(p.each);
      }
    }
  });

  it.each([
    { periods: 1, each: 20_000, first: 20_000 },
    { periods: 3, each: 6666, first: 6668 },
    { periods: 6, each: 3333, first: 3335 },
    { periods: 9, each: 2222, first: 2224 },
    { periods: 12, each: 1666, first: 1674 },
  ])("covers $periods 期 at the merchant's 零利率 rate", ({ periods, each, first }) => {
    // The period counts this UAT merchant really offers (recorded from vender/get_fee).
    // ⚠️ The期別 figures below are DERIVED from the manual's formula, not recorded — the
    // server only reports first_payment/each_payment via the notify and reserve_pos,
    // both of which need the consumer app. Recorded values would supersede these.
    const plan = calculateInstalmentPlan(20_000, periods, 0);
    expect(plan.each).toBe(each);
    expect(plan.first).toBe(first);
    expect(plan.interest).toBe(0);
  });

  it("always bills exactly the total across the whole schedule", () => {
    // The property that matters regardless of rounding: the instalments must sum to the
    // total, which is what loading the residue onto the first payment achieves.
    for (const periods of [1, 2, 3, 6, 7, 9, 12, 24]) {
      for (const rate of [0, 3, 6, 12.5]) {
        for (const amount of [1, 999, 1000, 20_000, 123_457]) {
          const p = calculateInstalmentPlan(amount, periods, rate);
          expect(p.first + p.each * (p.periods - 1)).toBe(p.total);
        }
      }
    }
  });

  it("leaves the total equal to the amount at a 零利率 rate", () => {
    const plan = calculateInstalmentPlan(12_345, 6, 0);
    expect(plan.total).toBe(12_345);
    expect(plan.interest).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the amount %j",
    async (amount) => {
      const err = await caught(() => calculateInstalmentPlan(amount, 3, 0));
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toContain("amount");
    },
  );

  it.each([0, -3, 2.5])("rejects the period count %j", async (periods) => {
    const err = await caught(() => calculateInstalmentPlan(1000, periods, 0));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("periods");
  });

  it("rejects a negative rate", async () => {
    const err = await caught(() => calculateInstalmentPlan(1000, 3, -1));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("feeRate");
  });
});

describe("期數利率表", () => {
  /** Exactly what vender/get_fee returned on UAT — note the rows are NOT sorted. */
  const schedule: ZingalaFeeSchedule = {
    vendorBorne: [
      { periods: 9, feeRate: 0 },
      { periods: 6, feeRate: 0 },
      { periods: 3, feeRate: 0 },
      { periods: 12, feeRate: 0 },
      { periods: 1, feeRate: 0 },
    ],
    consumerBorne: [],
  };

  it("sorts the period counts, since the API does not", () => {
    expect(availablePeriods(schedule, "vendor")).toEqual([1, 3, 6, 9, 12]);
  });

  it("finds a rate by period count rather than by position", () => {
    // Positional indexing would read 9期 as the first row. Recorded order is 9,6,3,12,1.
    expect(findFeeOption(schedule, "vendor", 12)).toEqual({ periods: 12, feeRate: 0 });
    expect(findFeeOption(schedule, "vendor", 18)).toBeUndefined();
  });

  it("reports an empty consumer-borne table, which is what 201 really means", () => {
    // `201 無配合費率外加(低利率)報價` is not about the period count — it means this
    // merchant has no consumer-borne rates at all. Checking here is cheaper than
    // discovering it from a rejected order.
    expect(availablePeriods(schedule, "consumer")).toEqual([]);
    expect(findFeeOption(schedule, "consumer", 3)).toBeUndefined();
  });
});
