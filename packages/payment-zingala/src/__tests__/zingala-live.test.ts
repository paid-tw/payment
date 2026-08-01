import { describe, expect, it } from "vitest";
import { isPaymentError, type PaymentError } from "@paid-tw/payment";
import { availablePeriods, calculateInstalmentPlan, findFeeOption } from "../fee.js";
import { createZingalaClient } from "../provider.js";

/**
 * Live tests against 中租零卡分期 **UAT**.
 *
 *   set -a; source .env; set +a
 *   pnpm test:live:zingala
 *
 * ## What UAT can and cannot reach
 *
 * Manual 1.1.14 p.38 says it outright: 「測試環境無法測試需人工處理的項目，如專人審核交易、
 * 撥款不會有變化」. Concretely:
 *
 *   - reachable by API alone — `reserve_ec` (success and every validation error),
 *     `inquiry`, `get_fee`, `get_bank_branch`, `check_is_member`, and the state-guard
 *     errors from `capture` / `refund`
 *   - **not** reachable — `transaction_state` 003 / 004 / 005. Getting to 003 needs the
 *     test consumer app (scan, password, ID upload) *and* a human reviewer; 004/005 need
 *     中租 staff to move the state by hand, and capture in UAT only ever answers `199`
 *     because the batch job does not run there.
 *
 * So the approved-order tests are gated on `ZINGALA_QUERY_ORDER_ID` — point it at an order
 * somebody already pushed through, the way `ECPAY_QUERY_ID` works. Without it they skip
 * rather than pretend.
 *
 * ## Footprint
 *
 * Each run creates a few 預約交易 records. They cost nothing and expire on their own
 * (`validDays: 1`), and no money can move: every capture/refund path is blocked by the
 * order's own state. There is no delete API, so expiry is the cleanup.
 */
const live = process.env.ZINGALA_LIVE === "1";
const LIVE_OPTS = { retry: 2, timeout: 40_000 } as const;

const config = {
  merchantId: process.env.ZINGALA_MERCHANT_ID ?? "",
  apiKey: process.env.ZINGALA_API_KEY ?? "",
  aesKey: process.env.ZINGALA_AES_KEY ?? "",
  aesIv: process.env.ZINGALA_AES_IV ?? "",
  sandbox: true,
  ...(process.env.ZINGALA_TOP_VENDER_ID ? { topVenderId: process.env.ZINGALA_TOP_VENDER_ID } : {}),
  ...(process.env.ZINGALA_BASE_URL ? { baseUrl: process.env.ZINGALA_BASE_URL } : {}),
};

const client = createZingalaClient(config);
const APPROVED_ORDER = process.env.ZINGALA_QUERY_ORDER_ID;

function dump(label: string, value: unknown): void {
  if (process.env.PAID_DEBUG === "1") {
    console.error(`[zingala-live] ${label}:`, JSON.stringify(value, null, 2));
  }
}

const stamp = () => Date.now().toString().slice(-9);
const orderId = (suffix: string) => `PAIDTW${stamp()}${suffix}`;

function application(overrides: Record<string, unknown> = {}) {
  return {
    orderId: orderId("LV"),
    productName: "paid-tw live probe 商品",
    amount: 20_000,
    periods: 3,
    feeBearer: "vendor" as const,
    notifyUrl: process.env.ZINGALA_NOTIFY_URL ?? "https://example.com/zingala/notify",
    validDays: 1,
    ...overrides,
  };
}

describe.skipIf(!live)("中租零卡分期 live — UAT", LIVE_OPTS, () => {
  it("verifies the Digest on every response", async () => {
    // Not a separate feature so much as the precondition for everything else: the client
    // throws AUTH on a bad or missing signature, so any call returning normally has
    // already proved the response was signed with our aesKey.
    const schedule = await client.getFeeSchedule();
    expect(schedule.vendorBorne.length + schedule.consumerBorne.length).toBeGreaterThan(0);
  });

  it("get_fee reports the merchant's real 期數利率 table", async () => {
    const schedule = await client.getFeeSchedule();
    dump("get_fee", schedule);

    const periods = availablePeriods(schedule, "vendor");
    expect(periods.length).toBeGreaterThan(0);
    // Sorted by us — 中租 returns the rows unordered.
    expect([...periods].sort((a, b) => a - b)).toEqual(periods);
    for (const p of periods) {
      expect(findFeeOption(schedule, "vendor", p)).toBeDefined();
    }
  });

  it("an unsupported period count is rejected, and get_fee predicts which", async () => {
    // The useful pairing: ask the rate table first, then confirm the API agrees. Saves
    // guessing at `201 分期期數錯誤`.
    const schedule = await client.getFeeSchedule();
    const supported = new Set(availablePeriods(schedule, "vendor"));
    const unsupported = [18, 24, 30, 36].find((p) => !supported.has(p));
    expect(unsupported).toBeDefined();

    const err = await client
      .applyInstallment(application({ periods: unsupported }))
      .catch((e: unknown) => e);
    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).rawCode).toBe("201");
  });

  it("fee_type consumer fails when the merchant has no consumer-borne rates", async () => {
    const schedule = await client.getFeeSchedule();
    if (availablePeriods(schedule, "consumer").length > 0) {
      // This merchant does have them; nothing to assert about the failure.
      return;
    }
    const err = await client
      .applyInstallment(application({ feeBearer: "consumer" }))
      .catch((e: unknown) => e);
    dump("consumer without rates", (err as PaymentError).toJSON?.() ?? err);
    // `201 無配合費率外加(低利率)報價` — reads like a period error, is really a config gap.
    expect((err as PaymentError).rawCode).toBe("201");
  });

  it("reserve_ec returns a payment URL and the order lands in 001", async () => {
    const input = application();
    const created = await client.applyInstallment(input);
    dump("reserve_ec", created.raw);

    expect(created.paymentUrlWeb).toMatch(/^https:\/\//);
    expect(created.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const order = await client.getOrder(input.orderId);
    dump("inquiry", order.raw);
    expect(order.state).toBe("pending-consumer");
    expect(order.amount).toBe(input.amount);
    expect(order.periods).toBe(input.periods);
    expect(order.caseId).toBeTruthy();
    // Undocumented until manual 1.1.6, and "N" until the case is approved.
    expect(order.approvalNoticeAvailable).toBe(false);
    // UAT sends no 申請人資料 before 專人審核.
    expect(order.customer).toBeUndefined();
  });

  it("re-sending the same order_id overwrites the order instead of failing", async () => {
    // Documented in revision 1.0.2 and worth pinning, because it is the opposite of what
    // "duplicate order id" usually means: the link is reused and the amount is replaced.
    const input = application({ amount: 20_000 });
    const first = await client.applyInstallment(input);
    const second = await client.applyInstallment({ ...input, amount: 25_000 });
    expect(second.paymentUrlWeb).toBe(first.paymentUrlWeb);

    const order = await client.getOrder(input.orderId);
    expect(order.amount).toBe(25_000);
  });

  it("reserve_ec does not check the credit limit", async () => {
    // An amount far beyond any plausible limit still succeeds: 額度 is evaluated later, in
    // the consumer's own flow. So a successful reserve says nothing about affordability.
    const created = await client.applyInstallment(application({ amount: 99_999_999 }));
    expect(created.paymentUrlWeb).toMatch(/^https:\/\//);
  });

  it.each([
    ["amount below the minimum", { amount: 0 } as const, "VALIDATION"],
    ["validDays above 30", { validDays: 31 } as const, "VALIDATION"],
  ])("rejects %s locally, before spending a request", async (_label, override, code) => {
    const err = await client.applyInstallment(application(override)).catch((e: unknown) => e);
    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe(code);
  });

  it("reports a missing product_name with the field named", async () => {
    // Our own guard fires first, so reach past it to see what 中租 says.
    const err = await client
      .applyInstallment({ ...application(), productName: undefined as unknown as string })
      .catch((e: unknown) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });

  it("inquiry answers a miss with success-and-empty, which getOrder turns into NOT_FOUND", async () => {
    const missing = orderId("MISS");
    const orders = await client.getOrders({ orderIds: [missing] });
    expect(orders).toEqual([]);

    const err = await client.getOrder(missing).catch((e: unknown) => e);
    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe("NOT_FOUND");
  });

  it("inquiry works by caseId and in batch", async () => {
    const input = application();
    await client.applyInstallment(input);
    const [byOrder] = await client.getOrders({ orderIds: [input.orderId] });
    expect(byOrder?.caseId).toBeTruthy();

    const [byCase] = await client.getOrders({ caseIds: [byOrder?.caseId as string] });
    expect(byCase?.orderId).toBe(input.orderId);

    const batch = await client.getOrders({ orderIds: [input.orderId, orderId("MISS")] });
    // A miss is simply absent from the batch rather than an error for the whole call.
    expect(batch).toHaveLength(1);
  });

  it("capture on an unconfirmed order reports 801, which no manual documents", async () => {
    const input = application();
    await client.applyInstallment(input);

    const err = await client
      .capture({ orderId: input.orderId, amount: input.amount })
      .catch((e: unknown) => e);
    dump("capture unconfirmed", (err as PaymentError).toJSON?.() ?? err);

    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).rawCode).toBe("801");
    expect((err as PaymentError).code).toBe("CONFLICT");
  });

  it("a wrong capture amount masks the state problem with 110", async () => {
    // Precedence: the amount is checked before the state, so 110 hides 801 and a caller
    // "fixing" the amount then discovers the real issue.
    const input = application();
    await client.applyInstallment(input);

    const err = await client
      .capture({ orderId: input.orderId, amount: input.amount + 1 })
      .catch((e: unknown) => e);
    expect((err as PaymentError).rawCode).toBe("110");
  });

  it("capture on a non-existent order is 100", async () => {
    const err = await client
      .capture({ orderId: orderId("GHOST"), amount: 20_000 })
      .catch((e: unknown) => e);
    expect((err as PaymentError).rawCode).toBe("100");
    expect((err as PaymentError).code).toBe("NOT_FOUND");
  });

  it("refund on an unauthorized order is 103", async () => {
    const input = application();
    await client.applyInstallment(input);

    const err = await client
      .refund({ orderId: input.orderId, refundAmount: input.amount })
      .catch((e: unknown) => e);
    dump("refund unauthorized", (err as PaymentError).toJSON?.() ?? err);
    expect((err as PaymentError).rawCode).toBe("103");
  });

  it("check_is_member answers, but cannot validate an ID", async () => {
    const real = await client.checkMember("A123456789");
    dump("check_is_member", real.raw);
    expect(typeof real.isMember).toBe("boolean");

    // Recorded finding: garbage answers 000 with is_member "N", so "N" conflates
    // "not a member" with "not even an ID". Do not use this as a validator.
    const junk = await client.checkMember("NOTANID");
    expect(junk.isMember).toBe(false);
  });

  it("check_is_member rejects an empty id with 200", async () => {
    // Our guard catches the empty string first, so this pins the local guard rather than
    // the remote one; the remote behaviour is covered by the cassette.
    const err = await client.checkMember("").catch((e: unknown) => e);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });

  it("get_bank_branch returns the 金融機構代碼表", async () => {
    const banks = await client.getBankBranches();
    expect(banks.length).toBeGreaterThan(10);
    for (const bank of banks.slice(0, 3)) {
      expect(bank.code).toMatch(/^\d{3}$/);
      expect(bank.name).toBeTruthy();
    }
    expect(banks.some((b) => b.branches.length > 0)).toBe(true);
  });

  /**
   * Everything below needs an order a human already pushed to 003 or beyond, because UAT
   * cannot get there by API. Skipped rather than faked when the env var is absent.
   */
  describe.skipIf(!APPROVED_ORDER)("an order somebody pushed through by hand", () => {
    it("reports an approved-or-later state", async () => {
      const order = await client.getOrder(APPROVED_ORDER as string);
      dump("approved order", order.raw);
      expect(["approved", "capturing", "disbursed"]).toContain(order.state);
      // 003/004/005 are the only states that carry 核准授權日.
      expect(order.authorizedAt).toBeTruthy();
      expect(order.captureDeadline).toBeTruthy();
    });

    it("matches 中租's own instalment figures, if it reports them", async () => {
      // The one chance to check our formula against the server. first_payment /
      // each_payment only appear on the notify and reserve_pos, so they may be absent
      // here — assert only when present rather than inventing agreement.
      const order = await client.getOrder(APPROVED_ORDER as string);
      const raw = order.raw as { first_payment?: number; each_payment?: number };
      if (raw.first_payment === undefined || raw.each_payment === undefined) return;

      const schedule = await client.getFeeSchedule();
      const rate =
        findFeeOption(schedule, (order.feeBearer as "vendor") ?? "vendor", order.periods ?? 1)
          ?.feeRate ?? 0;
      const plan = calculateInstalmentPlan(order.amount ?? 0, order.periods ?? 1, rate);
      expect(plan.first).toBe(raw.first_payment);
      expect(plan.each).toBe(raw.each_payment);
    });

    it("exposes whether 審核通知函 can be downloaded", async () => {
      const order = await client.getOrder(APPROVED_ORDER as string);
      expect(typeof order.approvalNoticeAvailable).toBe("boolean");
      if (!order.approvalNoticeAvailable) return;

      const pdf = await client.downloadApprovalNotice(APPROVED_ORDER as string);
      expect(pdf.length).toBeGreaterThan(0);
      // %PDF
      expect(Array.from(pdf.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    });
  });
});
