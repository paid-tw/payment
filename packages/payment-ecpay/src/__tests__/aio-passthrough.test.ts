import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PaymentError } from "@paid-tw/payment";
import { computeCheckMacValue } from "../provider.js";
import type { EcpayCreatePaymentInput } from "../provider.js";
import { HASH_IV, HASH_KEY, MERCHANT, server, testProvider } from "./ecpay-server.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** createPayment builds a form locally — no HTTP — so these need no handlers. */
function base(overrides: Partial<EcpayCreatePaymentInput> = {}): EcpayCreatePaymentInput {
  return {
    amount: 321,
    currency: "TWD",
    method: "atm",
    orderId: "AIOPASS0001",
    itemDesc: "paid-tw passthrough",
    notifyUrl: "https://shop.test/notify",
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<PaymentError> {
  return (await promise.catch((e: unknown) => e)) as PaymentError;
}

/** Recompute the MAC over everything except CheckMacValue itself. */
function macOver(params: Record<string, string>): string {
  const { CheckMacValue: _omit, ...rest } = params;
  return computeCheckMacValue(rest, HASH_KEY, HASH_IV);
}

describe("AIO typed optional fields", () => {
  it("maps every common field to its ECPay parameter name", async () => {
    const form = await testProvider().createPayment(
      base({
        storeId: "S1",
        clientBackUrl: "https://shop.test/back",
        itemUrl: "https://shop.test/item",
        remark: "note",
        chooseSubPayment: "TAISHIN",
        orderResultUrl: "https://shop.test/result",
        ignorePayment: "Credit#WebATM",
        platformId: "3002608",
        customField1: "c1",
        customField2: "c2",
        customField3: "c3",
        customField4: "c4",
        language: "ENG",
      }),
    );

    expect(form.params).toMatchObject({
      StoreID: "S1",
      ClientBackURL: "https://shop.test/back",
      ItemURL: "https://shop.test/item",
      Remark: "note",
      ChooseSubPayment: "TAISHIN",
      OrderResultURL: "https://shop.test/result",
      IgnorePayment: "Credit#WebATM",
      PlatformID: "3002608",
      CustomField1: "c1",
      CustomField2: "c2",
      CustomField3: "c3",
      CustomField4: "c4",
      Language: "ENG",
    });
  });

  it("omits fields that were not provided instead of sending blanks", async () => {
    // An empty form field is not the same as an absent one: it changes the signed set.
    const form = await testProvider().createPayment(base());
    for (const key of ["StoreID", "Remark", "Language", "PlatformID", "ItemURL"]) {
      expect(form.params).not.toHaveProperty(key);
    }
  });

  it("maps the take-number hooks", async () => {
    const form = await testProvider().createPayment(
      base({
        paymentInfoUrl: "https://shop.test/paid-info",
        clientRedirectUrl: "https://shop.test/code",
      }),
    );
    expect(form.params.PaymentInfoURL).toBe("https://shop.test/paid-info");
    expect(form.params.ClientRedirectURL).toBe("https://shop.test/code");
  });

  it("lets an explicit orderResultUrl win over the returnUrl shorthand", async () => {
    // returnUrl sets both OrderResultURL and ClientBackURL as a convenience; naming a
    // field explicitly is the more specific intent and must take precedence.
    const form = await testProvider().createPayment(
      base({
        returnUrl: "https://shop.test/generic",
        orderResultUrl: "https://shop.test/specific",
      }),
    );
    expect(form.params.OrderResultURL).toBe("https://shop.test/specific");
    expect(form.params.ClientBackURL).toBe("https://shop.test/generic");
  });
});

describe("AIO params escape hatch", () => {
  it("merges arbitrary fields and stringifies numbers", async () => {
    const form = await testProvider().createPayment(
      base({ params: { ExpireDate: 7, StoreExpireDate: 10_080, Desc_1: "line" } }),
    );
    expect(form.params.ExpireDate).toBe("7");
    expect(form.params.StoreExpireDate).toBe("10080");
    expect(form.params.Desc_1).toBe("line");
  });

  it("drops undefined entries but keeps an explicit empty string", async () => {
    const form = await testProvider().createPayment(
      base({ params: { Absent: undefined, Blank: "" } }),
    );
    expect(form.params).not.toHaveProperty("Absent");
    expect(form.params.Blank).toBe("");
  });

  it("signs the CheckMacValue over the passthrough too", async () => {
    // The whole point: a field ECPay validates must be inside the MAC, or the order is
    // rejected and the cause is invisible.
    const form = await testProvider().createPayment(
      base({ params: { ExpireDate: 7 }, paymentInfoUrl: "https://shop.test/paid-info" }),
    );
    expect(form.params.CheckMacValue).toBe(macOver(form.params));

    // And the MAC genuinely depends on the passthrough value.
    const other = await testProvider().createPayment(base({ params: { ExpireDate: 30 } }));
    expect(other.params.CheckMacValue).not.toBe(form.params.CheckMacValue);
  });

  it.each([
    "MerchantID",
    "MerchantTradeNo",
    "MerchantTradeDate",
    "PaymentType",
    "TotalAmount",
    "ReturnURL",
    "ChoosePayment",
    "EncryptType",
    "CheckMacValue",
  ])("refuses to let params override the derived/signed %s", async (key) => {
    // Two sources of truth for a signed field is how you get a MAC that does not match
    // what you meant to send — so this is rejected rather than merged.
    const err = await caught(testProvider().createPayment(base({ params: { [key]: "evil" } })));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain(key);
    expect(err.message).toMatch(/不可覆寫/);
  });

  it('rejects a non-finite number rather than sending "NaN"', async () => {
    const err = await caught(
      testProvider().createPayment(base({ params: { ExpireDate: Number.NaN } })),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(/不是有效數值/);
  });

  it("still produces a usable form with no params at all", async () => {
    const form = await testProvider().createPayment(base());
    expect(form.mode).toBe("redirect");
    expect(form.params.CheckMacValue).toBe(macOver(form.params));
    expect(form.params.MerchantID).toBe(MERCHANT);
  });

  it("maps barcode to its own ChoosePayment", async () => {
    const form = await testProvider().createPayment(base({ method: "barcode" }));
    expect(form.params.ChoosePayment).toBe("BARCODE");
  });
});
