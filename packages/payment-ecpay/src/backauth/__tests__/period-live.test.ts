import { afterAll, describe, expect, it } from "vitest";
import { isPaymentError, type PaymentError } from "@paid-tw/payment";
import { ECPAY_SANDBOX_NO_3D, ECPAY_TEST_CARD } from "../config.js";
import { createEcpayBackAuthProvider } from "../provider.js";

/**
 * Live 定期定額 lifecycle against **ecpayment-stage**, merchant 2000132 (3D off).
 *
 *   ECPAY_LIVE=1 PAID_DEBUG=1 pnpm test:live:ecpay:period
 *
 * ## Footprint
 *
 * A 定期定額 order is the one thing in this repo whose creation has a *continuing*
 * effect: ECPay keeps charging it on a schedule, and there is no endpoint to delete an
 * order. So this suite is written to leave as little behind as possible:
 *
 *   - It creates **one** schedule per run, using the smallest legal one — `Y` /
 *     frequency 1 / execTimes 2 / **5 TWD**. `Y` is deliberate: even if a cancel were
 *     to fail, the next charge is a year away rather than tomorrow.
 *   - It **cancels in `afterAll`**, so an assertion failure mid-suite still stops the
 *     schedule. This is the important part — a `finally` inside one test would not
 *     protect the others.
 *   - Cycle 1 **is charged at create time** — 5 TWD of stage money per run,
 *     unavoidable, since ECPay authorizes immediately and there is no dry-run.
 *
 * Cancelled stage orders from the recording run: see `STAGE_PERIOD_ORDER_IDS`.
 *
 * ## Not reachable here
 *
 * A **second** cycle actually firing, and therefore `ReAuth` on a genuinely failed
 * cycle. The shortest cadence is one day, so observing cycle 2 means waiting a day and
 * the fastest schedule (`D`/1) would keep charging until it is stopped. `ReAuth` is
 * covered in its refusal direction instead (below), and the success direction is
 * exercised offline against the recorded payloads.
 */
const live = process.env.ECPAY_LIVE === "1";
const LIVE_OPTS = { retry: 2, timeout: 40_000 } as const;

function dump(label: string, value: unknown): void {
  if (process.env.PAID_DEBUG === "1") {
    console.error(`[period-live] ${label}:`, JSON.stringify(value, null, 2));
  }
}

const provider = createEcpayBackAuthProvider({ ...ECPAY_SANDBOX_NO_3D });

/** Every schedule this run created, so afterAll can stop all of them. */
const created: string[] = [];

function testCard() {
  return {
    cardNo: ECPAY_TEST_CARD.cardNo,
    expiryMonth: "12",
    expiryYear: String((new Date().getUTCFullYear() + 4) % 100).padStart(2, "0"),
    cvv: ECPAY_TEST_CARD.cvv,
  };
}

/** The smallest legal schedule — see the footprint note. */
async function createSmallestSchedule() {
  const orderId = `PD${Date.now().toString().slice(-11)}`;
  const result = await provider.createPayment({
    amount: 5,
    currency: "TWD",
    method: "card",
    orderId,
    itemDesc: "paid-tw period probe",
    notifyUrl: "https://example.com/ecpay/backauth/notify",
    orderResultUrl: "https://example.com/ecpay/backauth/result",
    card: testCard(),
    phone: "886912345678",
    cardholderName: "TEST USER",
    period: { amount: 5, type: "Y", frequency: 1, execTimes: 2 },
  });
  created.push(orderId);
  if (result.mode !== "authorized") throw new Error("expected a direct authorization");
  return { orderId, result };
}

afterAll(async () => {
  // Runs even when a test above failed — that is the point.
  if (!live) return;
  const stranded: string[] = [];
  for (const orderId of created) {
    // Cancel is idempotent enough for this: a second Cancel on a stopped schedule is
    // harmless, so tests may cancel their own order without breaking cleanup.
    await provider.creditCardPeriodAction({ orderId, action: "Cancel" }).catch(() => undefined);
    // Then *verify* it, rather than trusting the call. A silent cleanup failure here
    // means real recurring charges, so it must be loud.
    const stopped = await provider
      .queryPeriodOrder({ merTradeNo: orderId })
      .then((o) => !o.isActive)
      .catch(() => false);
    if (!stopped) stranded.push(orderId);
  }
  if (stranded.length > 0) {
    throw new Error(
      `[period-live] STILL ACTIVE — cancel these in 廠商後台 or they keep charging: ${stranded.join(", ")}`,
    );
  }
});

describe.skipIf(!live)("ECPay 定期定額 live — stage", LIVE_OPTS, () => {
  it("creates a schedule, and charges cycle 1 immediately", async () => {
    const { orderId, result } = await createSmallestSchedule();
    dump("create", result.raw);

    expect(result.success).toBe(true);
    expect(result.merTradeNo).toBe(orderId);
    // The schedule comes back inside CardInfo, alongside the ordinary card fields.
    expect(result.period).toMatchObject({
      type: "Y",
      frequency: 1,
      execTimes: 2,
      periodAmount: 5,
    });
    // Cycle 1 already happened: this is not a "schedule starts later" API.
    expect(result.period?.totalSuccessTimes).toBe(1);
    expect(result.period?.totalSuccessAmount).toBe(5);
    expect(result.card?.gwsr).toBeGreaterThan(0);

    // Pins where ECPay really puts the period data, against the live payload.
    const cardInfo = result.raw.CardInfo as Record<string, unknown>;
    expect(cardInfo.PeriodType).toBe("Y");
    expect(result.raw).not.toHaveProperty("PeriodInfo");
  });

  it("query returns the undocumented ExecLog and ExecStatus", async () => {
    const { orderId } = await createSmallestSchedule();
    const order = await provider.queryPeriodOrder({ merTradeNo: orderId });
    dump("query", order.raw);

    // Neither field appears in doc 9093's field list, so assert they are really there —
    // if ECPay ever drops them, this suite should be what tells us.
    expect(order.raw).toHaveProperty("ExecLog");
    expect(order.raw).toHaveProperty("ExecStatus");

    expect(order.isActive).toBe(true);
    expect(order.execStatus).toBe("1");

    // One entry per charged cycle, so exactly one right after create.
    expect(order.executions).toHaveLength(1);
    const first = order.executions[0];
    expect(first?.rtnCode).toBe(1);
    expect(first?.amount).toBe(5);
    expect(first?.authCode).toBeTruthy();
    // Each cycle carries its own TradeNo — that is what makes the log useful for
    // reconciliation, and cycle 1's matches the order's.
    expect(first?.tradeNo).toBe(order.tradeNo);
    expect(first?.processDate).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);

    expect(order.period).toMatchObject({ type: "Y", totalSuccessTimes: 1 });
  });

  it("Cancel stops it, and only ExecStatus changes", async () => {
    const { orderId } = await createSmallestSchedule();
    const before = await provider.queryPeriodOrder({ merTradeNo: orderId });

    const cancelled = await provider.creditCardPeriodAction({ orderId, action: "Cancel" });
    dump("cancel", cancelled.raw);
    expect(cancelled.rtnCode).toBe(1);
    // Success text here is Chinese while the rest of BackAuth answers "Succeeded." —
    // pinned so nobody is tempted to branch on RtnMsg.
    expect(cancelled.rtnMsg).toContain("停用");

    const after = await provider.queryPeriodOrder({ merTradeNo: orderId });
    dump("query after cancel", after.raw);

    expect(after.isActive).toBe(false);
    expect(after.execStatus).toBe("0");
    // And the fields a caller might reach for instead do *not* move: the trade is still
    // paid and the counters are unchanged, so ExecStatus is the only usable signal.
    expect(after.status).toBe(before.status);
    expect(after.period?.totalSuccessTimes).toBe(before.period?.totalSuccessTimes);
    expect(after.executions).toHaveLength(before.executions.length);
  });

  it("ReAuth on a cancelled schedule is a terminal CONFLICT", async () => {
    const { orderId } = await createSmallestSchedule();
    await provider.creditCardPeriodAction({ orderId, action: "Cancel" });

    const err = await provider
      .creditCardPeriodAction({ orderId, action: "ReAuth" })
      .catch((e: unknown) => e);
    dump("reauth after cancel", (err as PaymentError).toJSON?.() ?? err);

    expect(isPaymentError(err)).toBe(true);
    // Cancel is irreversible — there is no resume endpoint — so this must not look
    // retryable to a caller.
    expect((err as PaymentError).code).toBe("CONFLICT");
    expect((err as PaymentError).rawCode).toBe("100006");
  });

  it("rejects an out-of-range schedule before spending money", async () => {
    // Guards the local validation against the live API's real ceilings: if ECPay ever
    // widened them, this would still pass, but the offline suite pins the numbers.
    const err = await provider
      .createPayment({
        amount: 5,
        currency: "TWD",
        method: "card",
        orderId: `PDBAD${Date.now().toString().slice(-8)}`,
        itemDesc: "paid-tw period range probe",
        notifyUrl: "https://example.com/ecpay/backauth/notify",
        orderResultUrl: "https://example.com/ecpay/backauth/result",
        card: testCard(),
        phone: "886912345678",
        cardholderName: "TEST USER",
        // ExecTimes 1 is rejected by ECPay too — verified by probing before this guard
        // existed. Nothing is created, so nothing needs cancelling.
        period: { amount: 5, type: "Y", frequency: 1, execTimes: 1 },
      })
      .catch((e: unknown) => e);

    expect(isPaymentError(err)).toBe(true);
    expect((err as PaymentError).code).toBe("VALIDATION");
  });

  it("queries a schedule that does not exist as an error, not an empty schedule", async () => {
    const err = await provider
      .queryPeriodOrder({ merTradeNo: `PDMISS${Date.now().toString().slice(-8)}` })
      .catch((e: unknown) => e);
    dump("query miss", (err as PaymentError).toJSON?.() ?? err);
    expect(isPaymentError(err)).toBe(true);
  });

  it("Cancel on an order that does not exist is an error", async () => {
    const err = await provider
      .creditCardPeriodAction({
        orderId: `PDMISS${Date.now().toString().slice(-8)}`,
        action: "Cancel",
      })
      .catch((e: unknown) => e);
    dump("cancel miss", (err as PaymentError).toJSON?.() ?? err);
    expect(isPaymentError(err)).toBe(true);
  });
});
