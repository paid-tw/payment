import { describe, expect, it } from "vitest";
import type { PaymentError } from "@paid-tw/payment";
import { computeDigest, encryptCustomerInfo } from "../crypto.js";
import {
  buildZingalaConfirmResponse,
  verifyZingalaConfirmRequest,
  verifyZingalaNotify,
  ZINGALA_NOTIFY_ACK,
} from "../notify.js";
import { TEST_API_KEY, TEST_IV, TEST_KEY } from "./zingala-server.js";

const CREDS = { apiKey: TEST_API_KEY, aesKey: TEST_KEY, aesIv: TEST_IV };

/**
 * ⚠️ These bodies are **doc-derived**, not recorded — they follow manual 1.1.14 p.11-13,
 * including its worked sample. Neither inbound call can be triggered from UAT without the
 * test consumer app and a human reviewer, so this is the one module in the package without
 * real payloads behind it. A recorded notify should replace these.
 *
 * The manual's own example, for reference:
 *   amount 50000, installment 12, fee_type vendor, first_payment 4163, each_payment 4167.
 */
function notifyBody(overrides: Record<string, unknown> = {}, customer?: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    result: "000",
    result_message: "成功",
    info_order: {
      order_id: "20190620test4",
      spanapp_id: "EPA041906200008",
      transaction_state: "003",
      amount: 50_000,
      installment: 12,
      fee_type: "vendor",
      first_payment: 4163,
      each_payment: 4167,
      auth_day: "2026-08-02 10:00:00",
      crd_cmptl_dt: "2026-08-02 09:55:00",
      ...(overrides.info_order as Record<string, unknown> | undefined),
    },
    ...(customer
      ? { info_customer_json: encryptCustomerInfo(customer, TEST_KEY, TEST_IV) }
      : { info_customer_json: "" }),
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (k !== "info_order") body[k] = v;
  }
  return JSON.stringify(body);
}

function signedHeaders(raw: string) {
  return { digest: computeDigest(raw, TEST_KEY), apiKey: TEST_API_KEY };
}

function caught(fn: () => unknown): PaymentError {
  try {
    fn();
  } catch (e) {
    return e as PaymentError;
  }
  throw new Error("expected a throw");
}

describe("verifyZingalaNotify", () => {
  it("normalizes an approval", () => {
    const raw = notifyBody();
    const notify = verifyZingalaNotify(raw, signedHeaders(raw), CREDS);

    expect(notify.orderId).toBe("20190620test4");
    expect(notify.caseId).toBe("EPA041906200008");
    expect(notify.state).toBe("approved");
    expect(notify.approved).toBe(true);
    expect(notify.failed).toBe(false);
    expect(notify.amount).toBe(50_000);
    expect(notify.firstPayment).toBe(4163);
    expect(notify.eachPayment).toBe(4167);
    expect(notify.authorizedAt).toBe("2026-08-02 10:00:00");
  });

  it.each([
    ["003 已核准", "003", true, false],
    ["004 請款中", "004", true, false],
    ["005 已撥款", "005", true, false],
    ["001 消費者未操作", "001", false, false],
    ["002 轉專員審核", "002", false, false],
    ["006 婉拒", "006", false, true],
    ["007 取消", "007", false, true],
    ["008 逾時", "008", false, true],
    ["009 部份取消中", "009", false, false],
  ])("reads %s as approved=%s failed=%s", (_label, state, approved, failed) => {
    const raw = notifyBody({ info_order: { transaction_state: state } });
    const notify = verifyZingalaNotify(raw, signedHeaders(raw), CREDS);
    expect(notify.approved).toBe(approved);
    expect(notify.failed).toBe(failed);
  });

  it("counts 004 and 005 as approved, not just 003", () => {
    // A notify can arrive after capture already began; treating only 003 as approved
    // would make a later notify look like a non-approval and stall the order.
    for (const state of ["004", "005"]) {
      const raw = notifyBody({ info_order: { transaction_state: state } });
      expect(verifyZingalaNotify(raw, signedHeaders(raw), CREDS).approved).toBe(true);
    }
  });

  it("decrypts 申請人資料 when 中租 sends it", () => {
    const raw = notifyBody(
      {},
      {
        cust_name: "王小明",
        cust_id: "A123456789",
        cust_phone: "0912345678",
      },
    );
    const notify = verifyZingalaNotify(raw, signedHeaders(raw), CREDS);
    expect(notify.customer).toMatchObject({ name: "王小明", id: "A123456789" });
  });

  it("leaves customer undefined when customer_info was 0", () => {
    const raw = notifyBody();
    expect(verifyZingalaNotify(raw, signedHeaders(raw), CREDS).customer).toBeUndefined();
  });

  it("rejects a tampered body", () => {
    // Sign the honest body, deliver a different one — the whole point of the Digest.
    const honest = notifyBody();
    const tampered = notifyBody({ info_order: { amount: 1 } });
    const err = caught(() => verifyZingalaNotify(tampered, signedHeaders(honest), CREDS));
    expect(err.code).toBe("AUTH");
    expect(err.message).toContain("Digest 驗證失敗");
  });

  it("rejects a body signed with the wrong key", () => {
    const raw = notifyBody();
    const err = caught(() =>
      verifyZingalaNotify(
        raw,
        { digest: computeDigest(raw, `${TEST_KEY.slice(0, 31)}X`), apiKey: TEST_API_KEY },
        CREDS,
      ),
    );
    expect(err.code).toBe("AUTH");
  });

  it("rejects a missing Digest", () => {
    const raw = notifyBody();
    const err = caught(() => verifyZingalaNotify(raw, { apiKey: TEST_API_KEY }, CREDS));
    expect(err.code).toBe("AUTH");
    expect(err.message).toContain("沒有 Digest");
  });

  it.each([
    ["missing", undefined],
    ["wrong", "not-the-key"],
    ["a prefix of the real one", TEST_API_KEY.slice(0, 10)],
  ])("rejects a %s 0Card-API-Key", (_label, apiKey) => {
    const raw = notifyBody();
    const err = caught(() =>
      verifyZingalaNotify(raw, { digest: computeDigest(raw, TEST_KEY), apiKey }, CREDS),
    );
    expect(err.code).toBe("AUTH");
    expect(err.message).toMatch(/0Card-API-Key/);
  });

  it("checks the API key before the Digest, so a stranger learns nothing", () => {
    // A caller with no credentials should be turned away on identity, not told their
    // signature was wrong.
    const raw = notifyBody();
    const err = caught(() => verifyZingalaNotify(raw, { digest: "0".repeat(64) }, CREDS));
    expect(err.message).toMatch(/0Card-API-Key/);
  });

  it("verifies the raw bytes, so a re-serialized body fails", () => {
    // The trap: a framework that parses then re-stringifies produces different bytes, and
    // the fix is to capture the raw text.
    //
    // Note the hand-written spacing. An already-canonical body survives the round trip
    // byte-for-byte, so writing this with `notifyBody()` would pass without proving
    // anything — which is exactly how the first version of this test was wrong.
    const raw =
      '{ "result": "000",\n  "info_order": { "order_id": "A1", "transaction_state": "003" } }';
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect(reserialized).not.toBe(raw);

    // The honest body verifies…
    expect(verifyZingalaNotify(raw, signedHeaders(raw), CREDS).orderId).toBe("A1");
    // …and the re-serialized one, carrying the same signature, does not.
    const err = caught(() => verifyZingalaNotify(reserialized, signedHeaders(raw), CREDS));
    expect(err.code).toBe("AUTH");
  });

  it.each(["", "   ", "not json", "[]", "null"])("rejects the malformed body %j", (body) => {
    const err = caught(() =>
      verifyZingalaNotify(
        body,
        { digest: computeDigest(body, TEST_KEY), apiKey: TEST_API_KEY },
        CREDS,
      ),
    );
    expect(["VALIDATION", "PROVIDER"]).toContain(err.code);
  });

  it("can be told to skip verification, which the docs discourage", () => {
    const raw = notifyBody();
    const notify = verifyZingalaNotify(raw, {}, CREDS, {
      allowUnsignedNotify: true,
      allowMissingApiKey: true,
    });
    expect(notify.approved).toBe(true);
  });

  it("passes an unmapped state through rather than throwing", () => {
    const raw = notifyBody({ info_order: { transaction_state: "042" } });
    const notify = verifyZingalaNotify(raw, signedHeaders(raw), CREDS);
    expect(notify.state).toBe("unknown");
    expect(notify.approved).toBe(false);
    expect(notify.failed).toBe(false);
    expect(notify.stateLabel).toContain("042");
  });

  it("gives idempotency a key that distinguishes the stages", () => {
    // Both notifies carry the same order_id, so deduping on it alone would drop the
    // approval as a replay of the in-review notify.
    const inReview = notifyBody({ info_order: { transaction_state: "002" } });
    const approved = notifyBody({ info_order: { transaction_state: "003" } });
    const a = verifyZingalaNotify(inReview, signedHeaders(inReview), CREDS);
    const b = verifyZingalaNotify(approved, signedHeaders(approved), CREDS);

    expect(a.orderId).toBe(b.orderId);
    expect(`${a.orderId}:${a.rawState}`).not.toBe(`${b.orderId}:${b.rawState}`);
  });

  it("acks with a bare 200, since the status is the acknowledgement", () => {
    expect(ZINGALA_NOTIFY_ACK.status).toBe(200);
  });
});

describe("verifyZingalaConfirmRequest", () => {
  it("extracts the order id", () => {
    const raw = JSON.stringify({ order_id: "20190620test3" });
    const request = verifyZingalaConfirmRequest(raw, { apiKey: TEST_API_KEY }, CREDS);
    expect(request.orderId).toBe("20190620test3");
  });

  it("requires the API key, which is the only authentication available here", () => {
    // The manual lists no Digest for comfirm_url — only 0Card-API-Key.
    const raw = JSON.stringify({ order_id: "X" });
    const err = caught(() => verifyZingalaConfirmRequest(raw, { apiKey: "wrong" }, CREDS));
    expect(err.code).toBe("AUTH");
  });

  it("rejects a body with no order_id", () => {
    const err = caught(() =>
      verifyZingalaConfirmRequest(JSON.stringify({}), { apiKey: TEST_API_KEY }, CREDS),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("order_id");
  });

  it("rejects a non-JSON body", () => {
    const err = caught(() => verifyZingalaConfirmRequest("nope", { apiKey: TEST_API_KEY }, CREDS));
    expect(err.code).toBe("PROVIDER");
  });

  it("builds the documented response shape", () => {
    expect(buildZingalaConfirmResponse(true)).toEqual({ valid: true });
    expect(buildZingalaConfirmResponse(false)).toEqual({ valid: false });
  });

  it("documents that silence means valid", () => {
    // 「若未回應 false，則代表皆為 true」 — so only an explicit false stops the review, and
    // a crashed handler reads as approval to continue. Pinned so the asymmetry is visible
    // in the test names rather than only in a comment.
    expect(buildZingalaConfirmResponse(false).valid).toBe(false);
    expect(buildZingalaConfirmResponse(true).valid).toBe(true);
  });
});
