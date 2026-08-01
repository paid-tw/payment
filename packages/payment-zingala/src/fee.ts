/**
 * 分期金額計算 — the schedule 中租 will actually bill, computed locally.
 *
 * Manual 1.1.14 p.33 gives the formula:
 *
 *     總應繳金額 = 交易金額 + round(交易金額 × fee_rate / 100)
 *     每期應繳款 = trunc(總應繳金額 / 分期期數)   ← the manual writes 四捨五入; see below
 *     第一期應繳款 = 每期應繳款 + (總應繳金額 − 每期應繳款 × 分期期數)
 *
 * ⚠️ **The manual says 四捨五入 but its own arithmetic truncates.** Its worked example is
 * 1000 元 / 6 期 / 6%: total 1060, 每期 **176**. But `1060 / 6 = 176.67`, which rounds to
 * **177** — only truncation gives 176, and the example's 首期 180 is consistent with that
 * (`176 + (1060 − 176×6)`). So the per-period step is implemented as truncation here,
 * matching the numbers rather than the label.
 *
 * Consequence: because truncation never overshoots, 首期 is always **≥** 每期; it absorbs
 * the leftover dollars. (With rounding it could come out below 每期 — that is what a
 * `Math.round` implementation would produce, and it disagrees with the manual.)
 *
 * ⚠️ **Unverified against the server.** `first_payment` / `each_payment` are only
 * returned by the notify and by `reserve_pos`, both of which need the consumer app, so
 * UAT cannot confirm which rounding 中租 really applies. The manual's example is the only
 * ground truth we have. If a recorded notify ever disagrees, this is the function to fix
 * and `__tests__/fee.test.ts` is where the golden lives.
 */
import { PaymentError } from "@paid-tw/payment";

const PROVIDER = "zingala";

export interface ZingalaInstalmentPlan {
  /** 交易金額 — the price of the goods. */
  amount: number;
  /** 分期期數 `prd_num`. */
  periods: number;
  /** 利率 `fee_rate`, as a percentage (e.g. `6` for 6%). */
  feeRate: number;
  /** 總應繳金額 — what the consumer pays in total. Equals `amount` at a 0% rate. */
  total: number;
  /** 第一期應繳款. Absorbs the leftover dollars, so it is always `>=` {@link each}. */
  first: number;
  /** 剩餘每期應繳款. */
  each: number;
  /** 利息 — `total - amount`. Zero when the merchant absorbs the fee (零利率). */
  interest: number;
}

/**
 * Compute the schedule for one plan.
 *
 * Mirrors the manual's arithmetic step by step — do not "simplify" to a single division,
 * which drifts by a dollar or two, and note the two steps round differently.
 */
export function calculateInstalmentPlan(
  amount: number,
  periods: number,
  feeRate: number,
): ZingalaInstalmentPlan {
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 1) {
    throw new PaymentError(
      "VALIDATION",
      `${PROVIDER} amount 必須是 >= 1 的整數（收到 ${String(amount)}）`,
      PROVIDER,
    );
  }
  if (!Number.isInteger(periods) || periods < 1) {
    throw new PaymentError(
      "VALIDATION",
      `${PROVIDER} periods 必須是 >= 1 的整數（收到 ${String(periods)}）`,
      PROVIDER,
    );
  }
  if (!Number.isFinite(feeRate) || feeRate < 0) {
    throw new PaymentError(
      "VALIDATION",
      `${PROVIDER} feeRate 必須是 >= 0 的數值（收到 ${String(feeRate)}）`,
      PROVIDER,
    );
  }

  // 總應繳金額 keeps 四捨五入 — the manual's example (1000 × 6% = 60) is exact, so it
  // cannot distinguish the two, and the stated rule is the only evidence here.
  const total = amount + halfUp((amount * feeRate) / 100);
  // 每期應繳款 truncates. See the note above: this is what reproduces 176, not 177.
  const each = Math.trunc(total / periods);
  // Leftover dollars land on the first instalment, so `first >= each` always.
  const first = each + (total - each * periods);

  return { amount, periods, feeRate, total, first, each, interest: total - amount };
}

/**
 * Round half away from zero, as the manual's 四捨五入 means.
 *
 * `Math.round` rounds half *up* (toward +∞), so it differs on negative halves. Inputs
 * here are non-negative, but being explicit keeps the intent readable rather than
 * relying on that.
 */
function halfUp(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** One row of `vender/get_fee`. */
export interface ZingalaFeeOption {
  /** 分期期數. */
  periods: number;
  /** 利率 %. `0` for the 零利率 plans a merchant absorbs. */
  feeRate: number;
}

/**
 * The rate table for a merchant, from `vender/get_fee`.
 *
 * Either list is `null` from 中租 when the merchant has no such arrangement, and that is
 * the real explanation for `201 無配合費率外加(低利率)報價`: it means
 * {@link consumerBorne} is empty, not that the period count was wrong. Recorded from UAT
 * 2026-08-02, where `consumer_fee_list` was `null` and 零利率 covered 1/3/6/9/12.
 */
export interface ZingalaFeeSchedule {
  /** 商家負擔 (零利率) — the merchant pays the fee. */
  vendorBorne: ZingalaFeeOption[];
  /** 消費者負擔 (利息外加) — the consumer pays interest. */
  consumerBorne: ZingalaFeeOption[];
}

/** Period counts available for a fee bearer, ascending. */
export function availablePeriods(
  schedule: ZingalaFeeSchedule,
  bearer: "vendor" | "consumer",
): number[] {
  const list = bearer === "vendor" ? schedule.vendorBorne : schedule.consumerBorne;
  return list.map((o) => o.periods).sort((a, b) => a - b);
}

/**
 * Look up the rate for a period count, or `undefined` when the merchant cannot offer it.
 *
 * Use this instead of assuming a rate: `get_fee` returns its rows **unordered** (recorded
 * as `9, 6, 3, 12, 1`), so indexing the array positionally is meaningless.
 */
export function findFeeOption(
  schedule: ZingalaFeeSchedule,
  bearer: "vendor" | "consumer",
  periods: number,
): ZingalaFeeOption | undefined {
  const list = bearer === "vendor" ? schedule.vendorBorne : schedule.consumerBorne;
  return list.find((o) => o.periods === periods);
}
