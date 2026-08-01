import { describe, expect, it } from "vitest";
import type { PaymentError } from "@paid-tw/payment";
import { encryptData } from "../../ecpg/aes.js";
import { ECPAY_PAYCODE_NOTIFY_ACK, verifyEcpayPayCodeNotify } from "../notify.js";
import {
  NOTIFY_ATM_SIMULATED,
  NOTIFY_BARCODE_SIMULATED,
  NOTIFY_CVS_SIMULATED,
  NOTIFY_ENVELOPE_SHAPE,
  NOTIFY_TRANSPORT,
} from "./paycode-fixtures.js";
import { HASH_IV, HASH_KEY, MERCHANT, testProvider } from "./paycode-server.js";

/**
 * ReturnURL notify coverage, driven by notifies **ECPay actually sent us**
 * (2026-08-01, stage merchant 3002607).
 *
 * How they were recorded, since it needs a public URL and cannot be scripted end
 * to end:
 *
 *   1. `pnpm capture:ecpay-notify` — logs each POST, decrypts `Data`, answers `1|OK`.
 *   2. Expose it over HTTPS (`cloudflared tunnel --url http://localhost:8787`).
 *   3. 取號 one order per method with `notifyUrl` pointing at the tunnel.
 *   4. Log into vendor-stage.ecpay.com.tw, 一般訂單查詢 → 全方位金流訂單, find each
 *      order and click 模擬付款.
 *   5. Paste what the capture script printed into `paycode-fixtures.ts`.
 *
 * Still doc-derived, and marked as such below: a **genuinely paid** notify
 * (`TradeStatus: "1"`, with `PayStoreID`/`PayStoreName`). 模擬付款 deliberately does
 * not settle, so only a real convenience-store payment produces that shape.
 */
const credentials = { hashKey: HASH_KEY, hashIv: HASH_IV, merchantId: MERCHANT };

function notify(data: Record<string, unknown>, transCode: number | string = 1) {
  return {
    ...NOTIFY_ENVELOPE_SHAPE,
    TransCode: transCode,
    Data: encryptData(data, HASH_KEY, HASH_IV),
  };
}

describe("ECPAY_PAYCODE_NOTIFY_ACK", () => {
  it("is the bare AIO string even though the notify is AES-JSON", () => {
    expect(ECPAY_PAYCODE_NOTIFY_ACK).toBe("1|OK");
  });

  it("records how ECPay delivers the notify", () => {
    // Pinned so a future reader does not have to re-derive it: JSON POST, wants
    // text/html back, from a UA that looks nothing like a modern client.
    expect(NOTIFY_TRANSPORT).toMatchObject({
      method: "POST",
      contentType: "application/json",
      accept: "text/html",
    });
  });
});

describe("verifyEcpayPayCodeNotify — recorded 模擬付款 notifies", () => {
  it("verifies the ATM notify and normalizes empty payer fields away", () => {
    const result = verifyEcpayPayCodeNotify(notify(NOTIFY_ATM_SIMULATED), credentials);

    expect(result.success).toBe(true);
    expect(result.method).toBe("atm");
    expect(result.merTradeNo).toBe("NFATM543393277");
    expect(result.tradeNo).toBe("2608010816330250");
    expect(result.amount).toBe(111);
    expect(result.paidAt).toBe("2026/08/01 08:20:57");
    // ATMAccBank/ATMAccNo came back as "" — must not surface as an empty object.
    expect(result.atm).toBeUndefined();
  });

  it("flags SimulatePaid, which is the only thing standing between this and shipping", () => {
    const result = verifyEcpayPayCodeNotify(notify(NOTIFY_ATM_SIMULATED), credentials);
    expect(result.simulated).toBe(true);
  });

  it("reports success on a notify whose TradeStatus is still 0", () => {
    // The trap this whole recording exercise uncovered: 模擬付款 sends RtnCode 1 and a
    // real PaymentDate but leaves TradeStatus at "0", because it deliberately does
    // not change payment state. Gating on tradeStatus would drop the notify.
    const result = verifyEcpayPayCodeNotify(notify(NOTIFY_ATM_SIMULATED), credentials);
    expect(result.rtnCode).toBe(1);
    expect(result.success).toBe(true);
    expect(result.tradeStatus).toBe("0");
    expect(result.paidAt).toBeTruthy();
  });

  it("verifies the CVS notify, including the chain it was paid at", () => {
    const result = verifyEcpayPayCodeNotify(notify(NOTIFY_CVS_SIMULATED), credentials);

    expect(result.success).toBe(true);
    expect(result.method).toBe("cvs");
    expect(result.cvs?.payFrom).toBe("family");
    expect(result.cvs?.paymentNo).toBe("LLL26213917403");
    // Recorded on vendor-stage, while 取號 returned payment-stage for the same code.
    expect(result.cvs?.paymentUrl).toContain("PaymentNo=LLL26213917403");
    // A simulated payment has no store, so these stay undefined even though 28010
    // documents them — anti-fraud store checks can't be rehearsed this way.
    expect(result.cvs?.payStoreId).toBeUndefined();
    expect(result.cvs?.payStoreName).toBeUndefined();
  });

  it("verifies the BARCODE notify, which carries only PayFrom", () => {
    const result = verifyEcpayPayCodeNotify(notify(NOTIFY_BARCODE_SIMULATED), credentials);

    expect(result.success).toBe(true);
    expect(result.method).toBe("barcode");
    expect(result.barcode).toEqual({ payFrom: "family" });
    expect(result.cvs).toBeUndefined();
    expect(result.atm).toBeUndefined();
  });

  it("keeps the fee and custom field ECPay echoed back", () => {
    const result = verifyEcpayPayCodeNotify(notify(NOTIFY_ATM_SIMULATED), credentials);
    expect(result.data.CustomField).toBe("notify-atm");
    // Fractional, as on the 取號 response.
    expect((result.data.OrderInfo as Record<string, unknown>).ChargeFee).toBe(1.11);
  });

  it("accepts the raw request text, not just a parsed body", () => {
    const result = verifyEcpayPayCodeNotify(
      JSON.stringify(notify(NOTIFY_CVS_SIMULATED)),
      credentials,
    );
    expect(result.merTradeNo).toBe("NFCVS543393277");
  });
});

describe("verifyEcpayPayCodeNotify — a genuinely paid notify (doc-derived)", () => {
  // 模擬付款 never yields TradeStatus "1", so this shape comes from 28010's field
  // list rather than a recording. Marked explicitly so it is not mistaken for one.
  const CVS_REALLY_PAID = {
    ...NOTIFY_CVS_SIMULATED,
    SimulatePaid: undefined,
    OrderInfo: { ...NOTIFY_CVS_SIMULATED.OrderInfo, TradeStatus: "1" },
    CVSInfo: {
      ...NOTIFY_CVS_SIMULATED.CVSInfo,
      PayStoreID: "166843",
      PayStoreName: "板橋德民店",
    },
  };

  it("is shippable: success, not simulated, and names the paying store", () => {
    const result = verifyEcpayPayCodeNotify(notify(CVS_REALLY_PAID), credentials);
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(false);
    expect(result.tradeStatus).toBe("1");
    expect(result.cvs).toMatchObject({ payStoreId: "166843", payStoreName: "板橋德民店" });
  });
});

describe("verifyEcpayPayCodeNotify — rejections", () => {
  it("reports RtnCode != 1 as not-success rather than throwing", () => {
    // ECPay is explicit that a non-1 RtnCode must not trigger fulfilment, but the
    // merchant still has to answer 1|OK, so this must not be an exception.
    const result = verifyEcpayPayCodeNotify(
      notify({ ...NOTIFY_ATM_SIMULATED, RtnCode: 10_100_058, RtnMsg: "ATM 繳費期限已過" }),
      credentials,
    );
    expect(result.success).toBe(false);
    expect(result.rtnCode).toBe(10_100_058);
    expect(result.rtnMsg).toBe("ATM 繳費期限已過");
  });

  it("rejects a tampered envelope (TransCode != 1)", () => {
    let err: PaymentError | undefined;
    try {
      verifyEcpayPayCodeNotify(notify(NOTIFY_ATM_SIMULATED, 0), credentials);
    } catch (e) {
      err = e as PaymentError;
    }
    expect(err?.code).toBe("PROVIDER");
    expect(err?.provider).toBe("ecpay-paycode");
  });

  it("rejects Data encrypted with someone else's keys", () => {
    const foreign = {
      ...NOTIFY_ENVELOPE_SHAPE,
      Data: encryptData(NOTIFY_ATM_SIMULATED, "0123456789abcdef", "abcdef0123456789"),
    };
    expect(() => verifyEcpayPayCodeNotify(foreign, credentials)).toThrowError(/解密失敗/);
  });

  it("rejects a notify for a different merchant", () => {
    expect(() =>
      verifyEcpayPayCodeNotify(
        notify({ ...NOTIFY_ATM_SIMULATED, MerchantID: "9999999" }),
        credentials,
      ),
    ).toThrowError(/MerchantID 不符/);
  });

  it("rejects a body that is not JSON", () => {
    expect(() => verifyEcpayPayCodeNotify("<html>oops</html>", credentials)).toThrowError(
      /不是合法 JSON/,
    );
  });

  it("rejects an envelope with no Data at all", () => {
    expect(() =>
      verifyEcpayPayCodeNotify({ MerchantID: MERCHANT, TransCode: 1 }, credentials),
    ).toThrowError(/缺少 Data/);
  });

  it("requires credentials", () => {
    expect(() =>
      verifyEcpayPayCodeNotify(notify(NOTIFY_ATM_SIMULATED), { hashKey: "", hashIv: "" }),
    ).toThrowError(/憑證/);
  });

  it("is reachable from the provider with the configured credentials", () => {
    const result = testProvider().verifyPaymentNotify(notify(NOTIFY_ATM_SIMULATED));
    expect(result.success).toBe(true);
    expect(result.merchantId).toBe(MERCHANT);
  });
});
