import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http } from "msw";
import { HttpResponse } from "msw";
import type { PaymentError } from "@paid-tw/payment";
import { computeDigest, encryptCustomerInfo } from "../crypto.js";
import {
  BASE,
  capture,
  PATHS,
  recorded,
  replay,
  respondWith,
  server,
  signed,
  TEST_IV,
  TEST_KEY,
  testClient,
} from "./zingala-server.js";
import type { ZingalaApplyInput } from "../provider.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function apply(overrides: Partial<ZingalaApplyInput> = {}): ZingalaApplyInput {
  return {
    orderId: "ORDER0001",
    productName: "舒潔衛生紙&三星 S10 手機(128GB)",
    amount: 20_000,
    periods: 3,
    feeBearer: "vendor",
    notifyUrl: "https://shop.test/zingala/notify",
    validDays: 7,
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<PaymentError> {
  return (await promise.catch((e: unknown) => e)) as PaymentError;
}

describe("transport", () => {
  it("sends the credential headers 中租 expects", async () => {
    const seen = capture(PATHS.getFee, { result: "000", result_message: "成功" });
    await testClient().getFeeSchedule();

    expect(seen.headers?.["0card-merchant-id"]).toBe("99999999");
    expect(seen.headers?.["0card-api-key"]).toBeTruthy();
    expect(seen.headers?.["content-type"]).toContain("application/json");
  });

  it("injects top_vender_id only when configured", async () => {
    const without = capture(PATHS.getFee, { result: "000" });
    await testClient().getFeeSchedule();
    expect(without.body).not.toHaveProperty("top_vender_id");

    const with_ = capture(PATHS.getFee, { result: "000" });
    await testClient({ topVenderId: "TOP123" }).getFeeSchedule();
    expect(with_.body?.top_vender_id).toBe("TOP123");
  });

  it("rejects a response whose Digest does not match", async () => {
    // The security property this package exists to provide, and the one the public
    // laravel implementation skips entirely.
    server.use(
      http.post(`${BASE}${PATHS.getFee}`, () =>
        HttpResponse.text('{"result":"000"}', {
          headers: {
            Digest: computeDigest('{"result":"000"}', "a-different-key-32-chars-long!!!"),
          },
        }),
      ),
    );
    const err = await caught(testClient().getFeeSchedule());
    expect(err.code).toBe("AUTH");
    expect(err.message).toContain("Digest 驗證失敗");
  });

  it("rejects a response with no Digest at all", async () => {
    server.use(http.post(`${BASE}${PATHS.getFee}`, () => HttpResponse.json({ result: "000" })));
    const err = await caught(testClient().getFeeSchedule());
    expect(err.code).toBe("AUTH");
    expect(err.message).toContain("沒有 Digest");
  });

  it("can be told to accept an unsigned response, for a header-stripping proxy", async () => {
    server.use(http.post(`${BASE}${PATHS.getFee}`, () => HttpResponse.json({ result: "000" })));
    const schedule = await testClient().getFeeSchedule({ allowUnsignedResponse: true });
    expect(schedule.vendorBorne).toEqual([]);
  });

  it("detects tampering, not just a wrong key", async () => {
    // Sign one body, serve another — exactly what an attacker in the middle would do.
    const honest = '{"result":"000","result_message":"成功"}';
    server.use(
      http.post(`${BASE}${PATHS.getFee}`, () =>
        HttpResponse.text('{"result":"000","result_message":"tampered"}', {
          headers: { Digest: computeDigest(honest, TEST_KEY) },
        }),
      ),
    );
    const err = await caught(testClient().getFeeSchedule());
    expect(err.code).toBe("AUTH");
  });

  it("reports a non-JSON body as PROVIDER", async () => {
    const body = "<html>maintenance</html>";
    server.use(http.post(`${BASE}${PATHS.getFee}`, () => signed(body)));
    const err = await caught(testClient().getFeeSchedule());
    expect(err.code).toBe("PROVIDER");
    expect(err.message).toContain("不是 JSON");
  });

  it("reports a JSON body with no result field", async () => {
    server.use(respondWith(PATHS.getFee, { unexpected: true }));
    const err = await caught(testClient().getFeeSchedule());
    expect(err.code).toBe("PROVIDER");
    expect(err.message).toContain("缺少 result");
  });

  it("maps a transport failure to NETWORK", async () => {
    server.use(http.post(`${BASE}${PATHS.getFee}`, () => HttpResponse.error()));
    const err = await caught(testClient().getFeeSchedule());
    expect(err.code).toBe("NETWORK");
  });

  it.each(["merchantId", "apiKey", "aesKey", "aesIv"] as const)(
    "refuses to send a request with %s missing",
    async (field) => {
      const err = await caught(testClient({ [field]: "" }).getFeeSchedule());
      expect(err.code).toBe("AUTH");
      expect(err.message).toContain(field);
    },
  );
});

describe("applyInstallment (reserve_ec)", () => {
  it("returns the consumer URL from the recorded response", async () => {
    server.use(replay(PATHS.reserveEc, "reserve_ec valid"));
    const application = await testClient().applyInstallment(apply());

    expect(application.paymentUrlWeb).toContain("transaction-uat.zingala.com");
    expect(application.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Recorded: the app link is byte-identical to the web one, despite the manual
    // treating them as separate and 1.1.0 claiming the app link was removed.
    expect(application.paymentUrlApp).toBe(application.paymentUrlWeb);
  });

  it("maps the input onto 中租's field names, typo included", async () => {
    const seen = capture(PATHS.reserveEc, JSON.parse(recorded("reserve_ec valid").body));
    await testClient().applyInstallment(
      apply({
        confirmUrl: "https://shop.test/confirm",
        displayUrl: "https://shop.test/done",
        autoCapture: true,
        receiveCustomerInfo: false,
        storeId: "S1",
        storeName: "測試櫃位",
      }),
    );

    expect(seen.body).toMatchObject({
      order_id: "ORDER0001",
      amount: 20_000,
      installment: 3,
      fee_type: "vendor",
      valid_days: 7,
      capture: true,
      customer_info: "0",
      store_id: "S1",
      store_name: "測試櫃位",
      display_url: "https://shop.test/done",
    });
    // 中租 spells it `comfirm_url`. Sending the correct spelling silently does nothing.
    expect(seen.body?.comfirm_url).toBe("https://shop.test/confirm");
    expect(seen.body).not.toHaveProperty("confirm_url");
  });

  it("omits optional fields rather than sending blanks", async () => {
    const seen = capture(PATHS.reserveEc, JSON.parse(recorded("reserve_ec valid").body));
    await testClient().applyInstallment(apply());
    for (const key of [
      "comfirm_url",
      "display_url",
      "capture",
      "customer_info",
      "store_id",
      "store_name",
      "buyer_data",
    ]) {
      expect(seen.body).not.toHaveProperty(key);
    }
  });

  it("builds buyer_data for the fields that were provided", async () => {
    const seen = capture(PATHS.reserveEc, JSON.parse(recorded("reserve_ec valid").body));
    await testClient().applyInstallment(
      apply({ buyer: { specificId: "A123456789", accountOlderThan30Days: true } }),
    );
    expect(seen.body?.buyer_data).toEqual({ specific_id: "A123456789", account_age: true });
  });

  it("surfaces a success with no payment_url as a PROVIDER error", async () => {
    server.use(respondWith(PATHS.reserveEc, { result: "000", info_reserve: null }));
    const err = await caught(testClient().applyInstallment(apply()));
    expect(err.code).toBe("PROVIDER");
    expect(err.message).toContain("payment_url_web");
  });

  it.each([
    ["參數錯誤 with the field named", "reserve_ec missing product_name", "VALIDATION", "200"],
    ["分期期數錯誤", "reserve_ec installment=99", "VALIDATION", "201"],
    ["valid_days 超出範圍", "reserve_ec valid_days=31", "VALIDATION", "200"],
    ["無效 fee_type 回 900", "reserve_ec fee_type=bogus", "PROVIDER", "900"],
  ])("normalizes the recorded failure: %s", async (_label, fragment, code, rawCode) => {
    server.use(replay(PATHS.reserveEc, fragment));
    const err = await caught(testClient().applyInstallment(apply()));
    expect(err.code).toBe(code);
    expect(err.rawCode).toBe(rawCode);
  });

  it("keeps the offending field name from a 200 message", async () => {
    server.use(replay(PATHS.reserveEc, "reserve_ec missing product_name"));
    const err = await caught(testClient().applyInstallment(apply()));
    expect(err.message).toContain("product_name");
  });
});

describe("applyInstallment validation, before any request", () => {
  // No handler is registered and the server errors on unhandled requests, so anything
  // escaping validation fails loudly instead of passing quietly.
  it.each([
    ["orderId", { orderId: "" }, /orderId/],
    ["productName", { productName: "" }, /productName/],
    ["amount 0", { amount: 0 }, /amount/],
    ["amount 1.5", { amount: 1.5 }, /amount/],
    ["periods 0", { periods: 0 }, /periods/],
    ["notifyUrl", { notifyUrl: "" }, /notifyUrl/],
    ["validDays 0", { validDays: 0 }, /validDays/],
    ["validDays 31", { validDays: 31 }, /validDays/],
  ] as const)("rejects %s locally", async (_label, override, pattern) => {
    const err = await caught(testClient().applyInstallment(apply(override)));
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(pattern);
  });

  it("rejects an unknown feeBearer locally, since the API answers 900 for it", async () => {
    const err = await caught(
      testClient().applyInstallment(apply({ feeBearer: "bogus" as "vendor" })),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("feeBearer");
  });

  it("explains why productName matters, not just that it is required", async () => {
    const err = await caught(testClient().applyInstallment(apply({ productName: "" })));
    expect(err.message).toMatch(/核准率/);
  });
});

describe("getOrders / getOrder (inquiry)", () => {
  it("normalizes the recorded order, including the undocumented pdf flag", async () => {
    server.use(replay(PATHS.inquiry, "inquiry on the new order"));
    const [order] = await testClient().getOrders({ orderIds: ["PAIDTW611843767OK1"] });

    expect(order?.state).toBe("pending-consumer");
    expect(order?.rawState).toBe("001");
    expect(order?.stateLabel).toContain("尚未");
    expect(order?.caseId).toBe("EPA99260802000007");
    expect(order?.amount).toBe(25_000);
    expect(order?.periods).toBe(3);
    expect(order?.reservedOn).toBe("20260802");
    // download_aprvnotice_pdf is "N" on a fresh order (manual 1.1.6).
    expect(order?.approvalNoticeAvailable).toBe(false);
  });

  it("drops 中租's placeholder refund row so refunds.length means something", async () => {
    // A fresh order still arrives with one all-null entry in refundlist.
    server.use(replay(PATHS.inquiry, "inquiry on the new order"));
    const [order] = await testClient().getOrders({ orderIds: ["PAIDTW611843767OK1"] });
    expect(order).toBeDefined();
    expect(order?.refunds).toEqual([]);
    // The raw payload really did contain a row — we dropped it, rather than 中租 omitting it.
    expect(order?.raw.refundlist).toHaveLength(1);
  });

  it("keeps a real refund row", async () => {
    server.use(
      respondWith(PATHS.inquiry, {
        result: "000",
        info: [
          {
            transaction_state: "007",
            order_id: "ORDER1",
            refundlist: [
              {
                refund_time: "2019-08-06 12:43:00",
                refund_amount: 10_000,
                final_amount: 0,
                refund_id: "019080621032567",
              },
            ],
          },
        ],
      }),
    );
    const [order] = await testClient().getOrders({ orderIds: ["ORDER1"] });
    expect(order?.refunds).toHaveLength(1);
    expect(order?.refunds[0]?.refundId).toBe("019080621032567");
    expect(order?.state).toBe("cancelled");
  });

  it("turns the empty-array miss into NOT_FOUND", async () => {
    // Recorded: an unknown order answers result 000 with info: []. getOrder must not
    // hand back undefined for that.
    server.use(replay(PATHS.inquiry, "inquiry (order that does not exist)"));
    const err = await caught(testClient().getOrder("NOPE"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("info 為空陣列");
  });

  it("returns an empty list from getOrders for the same response", async () => {
    // The batch form reports "nothing matched" honestly rather than throwing.
    server.use(replay(PATHS.inquiry, "inquiry (order that does not exist)"));
    const orders = await testClient().getOrders({ orderIds: ["NOPE"] });
    expect(orders).toEqual([]);
  });

  it("sends both id lists, empty rather than missing", async () => {
    const seen = capture(PATHS.inquiry, { result: "000", info: [] });
    await testClient().getOrders({ orderIds: ["A", "B"] });
    expect(seen.body?.order_id_list).toEqual([{ id: "A" }, { id: "B" }]);
    expect(seen.body?.spanapp_id_list).toEqual([]);
  });

  it("queries by caseId as well", async () => {
    const seen = capture(PATHS.inquiry, { result: "000", info: [] });
    await testClient().getOrders({ caseIds: ["EPA99260802000007"] });
    expect(seen.body?.spanapp_id_list).toEqual([{ id: "EPA99260802000007" }]);
    expect(seen.body?.order_id_list).toEqual([]);
  });

  it("requires at least one id", async () => {
    const err = await caught(testClient().getOrders({}));
    expect(err.code).toBe("VALIDATION");
  });

  it("refuses more than the documented 100 ids", async () => {
    const err = await caught(
      testClient().getOrders({ orderIds: Array.from({ length: 101 }, (_, i) => `O${i}`) }),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("100");
  });

  it("decrypts the customer envelope when 中租 sends one", async () => {
    const encrypted = encryptCustomerInfo(
      { cust_name: "王小明", cust_id: "A123456789", cust_phone: "0912345678" },
      TEST_KEY,
      TEST_IV,
    );
    server.use(
      respondWith(PATHS.inquiry, {
        result: "000",
        info: [{ transaction_state: "003", order_id: "ORDER1", info_customer_json: encrypted }],
      }),
    );
    const [order] = await testClient().getOrders({ orderIds: ["ORDER1"] });
    expect(order?.customer?.name).toBe("王小明");
    expect(order?.state).toBe("approved");
  });

  it("leaves customer undefined for the empty envelope UAT sends", async () => {
    server.use(replay(PATHS.inquiry, "inquiry on the new order"));
    const [order] = await testClient().getOrders({ orderIds: ["PAIDTW611843767OK1"] });
    expect(order?.customer).toBeUndefined();
  });

  it("passes an unmapped state through instead of throwing", async () => {
    server.use(
      respondWith(PATHS.inquiry, {
        result: "000",
        info: [{ transaction_state: "042", order_id: "ORDER1" }],
      }),
    );
    const [order] = await testClient().getOrders({ orderIds: ["ORDER1"] });
    expect(order?.state).toBe("unknown");
    expect(order?.stateLabel).toContain("042");
  });
});

describe("capture", () => {
  it("maps the undocumented 801 to CONFLICT", async () => {
    // Recorded with a correct amount on an unconfirmed order. Absent from every manual.
    server.use(replay(PATHS.capture, "capture with the CORRECT amount"));
    const err = await caught(testClient().capture({ orderId: "ORDER1", amount: 20_000 }));
    expect(err.code).toBe("CONFLICT");
    expect(err.rawCode).toBe("801");
    expect(err.message).toContain("尚未確認");
  });

  it("reports the amount mismatch that masks the state problem", async () => {
    // 110 wins over 801 when the amount is also wrong, so a caller "fixing" the amount
    // then discovers the real issue. Pinned so the ordering is documented by a test.
    server.use(replay(PATHS.capture, "capture with a WRONG amount"));
    const err = await caught(testClient().capture({ orderId: "ORDER1", amount: 999 }));
    expect(err.code).toBe("VALIDATION");
    expect(err.rawCode).toBe("110");
  });

  it("maps a missing order to NOT_FOUND", async () => {
    server.use(replay(PATHS.capture, "capture on an order that does not exist"));
    const err = await caught(testClient().capture({ orderId: "GHOST", amount: 20_000 }));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.rawCode).toBe("100");
  });

  it("normalizes a successful capture", async () => {
    server.use(
      respondWith(PATHS.capture, {
        result: "000",
        info_order: {
          order_id: "ORDER1",
          store: null,
          amount: 50_000,
          installment: 12,
          fee_type: "vendor",
          fn_ma: 100,
        },
      }),
    );
    const result = await testClient().capture({ orderId: "ORDER1", amount: 50_000 });
    expect(result).toMatchObject({ orderId: "ORDER1", amount: 50_000, advisoryFee: 100 });
    expect(result.store).toBeUndefined();
  });

  it("treats 199 as the retryable batch-not-run case", async () => {
    server.use(
      respondWith(PATHS.capture, {
        result: "199",
        result_message: "此訂單已核准但尚有資料待補建檔，請隔日或稍後再試",
        info_order: null,
      }),
    );
    const err = await caught(testClient().capture({ orderId: "ORDER1", amount: 1 }));
    expect(err.code).toBe("PROVIDER");
    expect(err.rawCode).toBe("199");
  });
});

describe("refund", () => {
  it("maps an unauthorized order to CONFLICT", async () => {
    server.use(replay(PATHS.refund, "refund before approval"));
    const err = await caught(testClient().refund({ orderId: "ORDER1", refundAmount: 20_000 }));
    expect(err.code).toBe("CONFLICT");
    expect(err.rawCode).toBe("103");
  });

  it("reads refund_id as a string, as manual 1.1.8 changed it", async () => {
    server.use(
      respondWith(PATHS.refund, {
        result: "000",
        info_refund: {
          refund_time: "2019-06-20 23:15:35",
          amount: 50_000,
          refund_amount: 50_000,
          final_amount: 0,
          refund_id: "219082057491857",
          pay_up: false,
        },
      }),
    );
    const result = await testClient().refund({ orderId: "ORDER1", refundAmount: 50_000 });
    expect(result.refundId).toBe("219082057491857");
    expect(result.paidUp).toBe(false);
    expect(result.remainingAmount).toBe(0);
  });

  it("still normalizes a numeric refund_id, as pre-1.1.8 documented it", async () => {
    server.use(
      respondWith(PATHS.refund, {
        result: "000",
        info_refund: { refund_id: 219_082_057_491_857, refund_amount: 1 },
      }),
    );
    const result = await testClient().refund({ orderId: "ORDER1", refundAmount: 1 });
    expect(result.refundId).toBe("219082057491857");
  });
});

describe("checkMember", () => {
  it("reads the recorded non-member answer", async () => {
    server.use(replay(PATHS.checkIsMember, "check_is_member (random ID)"));
    const result = await testClient().checkMember("A123456789");
    expect(result.isMember).toBe(false);
    expect(result.signupUrl).toContain("zingala.com");
  });

  it("does not treat a syntactically invalid id as an error", async () => {
    // Recorded: `cust_id: "NOTANID"` answers 000 with is_member "N", so this API cannot
    // be used to validate an ID — "N" conflates "not a member" with "not an ID".
    server.use(replay(PATHS.checkIsMember, 'cust_id="NOTANID"'));
    const result = await testClient().checkMember("NOTANID");
    expect(result.isMember).toBe(false);
  });

  it("maps the empty id rejection", async () => {
    server.use(replay(PATHS.checkIsMember, 'cust_id=""'));
    const err = await caught(testClient().checkMember("x"));
    expect(err.code).toBe("VALIDATION");
    expect(err.rawCode).toBe("200");
  });

  it("requires an id locally", async () => {
    const err = await caught(testClient().checkMember(""));
    expect(err.code).toBe("VALIDATION");
  });
});

describe("getFeeSchedule", () => {
  it("normalizes the recorded rate table and its null consumer list", async () => {
    server.use(replay(PATHS.getFee, "vender/get_fee"));
    const schedule = await testClient().getFeeSchedule();

    expect(schedule.vendorBorne).toHaveLength(5);
    // Recorded order is 9,6,3,12,1 — preserved here; sorting is availablePeriods' job.
    expect(schedule.vendorBorne[0]?.periods).toBe(9);
    // `consumer_fee_list: null` is why this merchant cannot use fee_type consumer.
    expect(schedule.consumerBorne).toEqual([]);
  });

  it("drops malformed rows rather than inventing a 0-period plan", async () => {
    server.use(
      respondWith(PATHS.getFee, {
        result: "000",
        vendor_fee_list: [{ prd_num: 3, fee_rate: 0 }, { fee_rate: 5 }, null],
      }),
    );
    const schedule = await testClient().getFeeSchedule();
    expect(schedule.vendorBorne).toEqual([{ periods: 3, feeRate: 0 }]);
  });
});

describe("getBankBranches", () => {
  it("normalizes the recorded bank table", async () => {
    server.use(replay(PATHS.getBankBranch, "vender/get_bank_branch"));
    const banks = await testClient().getBankBranches();

    expect(banks.length).toBeGreaterThan(30);
    const first = banks[0];
    expect(first?.code).toBe("004");
    expect(first?.name).toBe("臺灣銀行");
    expect(first?.branches.length).toBeGreaterThan(100);
    expect(first?.branches[0]).toEqual({ code: "0000", name: "台銀" });
  });

  it("tolerates a bank with no branch list", async () => {
    server.use(
      respondWith(PATHS.getBankBranch, {
        result: "000",
        bank: [{ bnk_id: "999", bnk_nme: "測試銀行" }],
      }),
    );
    const banks = await testClient().getBankBranches();
    expect(banks[0]?.branches).toEqual([]);
  });
});

describe("downloadApprovalNotice", () => {
  it("returns the bytes when 中租 sends a PDF", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
    server.use(
      http.post(`${BASE}${PATHS.downloadApprovalNotice}`, () =>
        HttpResponse.arrayBuffer(pdf.buffer as ArrayBuffer, {
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    );
    const bytes = await testClient().downloadApprovalNotice("ORDER1");
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("normalizes an error even though the endpoint returns binary on success", async () => {
    // 中租 answers this endpoint with the ordinary JSON envelope when it fails, so a
    // caller must not receive an "PDF" that is really `202 查無相關的文審要件資料`.
    server.use(
      http.post(`${BASE}${PATHS.downloadApprovalNotice}`, () =>
        HttpResponse.json({ result: "202", result_message: "查無相關的文審要件資料" }),
      ),
    );
    const err = await caught(testClient().downloadApprovalNotice("ORDER1"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.rawCode).toBe("202");
  });

  it("detects a JSON error body sent without a JSON content type", async () => {
    server.use(
      http.post(`${BASE}${PATHS.downloadApprovalNotice}`, () =>
        HttpResponse.text('{"result":"202","result_message":"查無"}', {
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    );
    const err = await caught(testClient().downloadApprovalNotice("ORDER1"));
    expect(err.rawCode).toBe("202");
  });

  it("rejects an empty body", async () => {
    server.use(
      http.post(`${BASE}${PATHS.downloadApprovalNotice}`, () =>
        HttpResponse.arrayBuffer(new ArrayBuffer(0), {
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    );
    const err = await caught(testClient().downloadApprovalNotice("ORDER1"));
    expect(err.code).toBe("PROVIDER");
  });

  it("requires an orderId locally", async () => {
    const err = await caught(testClient().downloadApprovalNotice(""));
    expect(err.code).toBe("VALIDATION");
  });
});
