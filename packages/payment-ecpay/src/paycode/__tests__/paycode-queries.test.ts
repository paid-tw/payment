import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PaymentError } from "@paid-tw/payment";
import { ECPAY_PAYCODE_PATHS } from "../config.js";
import { parseTradeMediaCsv } from "../provider.js";
import type { EcpayCvsBarcodeChain, EcpayTradeMediaQuery } from "../provider.js";
import {
  CVS_BARCODE_FAMILY,
  CVS_BARCODE_HILIFE,
  CVS_BARCODE_IBON,
  TRADE_MEDIA_COLUMNS,
  TRADE_MEDIA_EMPTY_CSV,
  TRADE_MEDIA_ONE_ROW_CSV,
  TRADE_MEDIA_TRANSCODE_128,
} from "./paycode-fixtures.js";
import {
  BASE,
  envelope,
  MERCHANT,
  readRequestData,
  respondWith,
  server,
  testProvider,
} from "./paycode-server.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BARCODE_URL = `${BASE}${ECPAY_PAYCODE_PATHS.queryCvsBarcode}`;
const MEDIA_URL = `${BASE}${ECPAY_PAYCODE_PATHS.queryTradeMedia}`;

describe("QueryCVSBarcode — getCvsBarcode", () => {
  it.each([
    ["iBon", CVS_BARCODE_IBON],
    ["Family", CVS_BARCODE_FAMILY],
    ["Hilife", CVS_BARCODE_HILIFE],
  ] as const)("returns %s's own segments", async (chain, fixture) => {
    server.use(respondWith(BARCODE_URL, fixture));
    const result = await testProvider().getCvsBarcode({
      paymentNo: "LLL26213917414",
      chain: chain as EcpayCvsBarcodeChain,
    });

    expect(result.chain).toBe(chain);
    expect(result.paymentNo).toBe("LLL26213917414");
    expect(result.barcode1).toBe(fixture.CVSInfo.Barcode1);
    expect(result.barcode2).toBe(fixture.CVSInfo.Barcode2);
    expect(result.barcode3).toBe(fixture.CVSInfo.Barcode3);
    expect(result.expireDate).toBe("2026/08/08 09:18:09");
    expect(result.rtnCode).toBe(1);
  });

  it("gives each chain different segments for the same 繳費代碼", () => {
    // Recorded live from one PaymentNo: iBon's Barcode2 is an opaque token while
    // Family/Hilife embed the zero-padded code, and Barcode3 differs across all
    // three. So a barcode fetched for one chain cannot be shown at another.
    const segments = [CVS_BARCODE_IBON, CVS_BARCODE_FAMILY, CVS_BARCODE_HILIFE].map(
      (f) => f.CVSInfo,
    );
    expect(new Set(segments.map((s) => s.Barcode1)).size).toBe(3);
    expect(new Set(segments.map((s) => s.Barcode3)).size).toBe(3);
    expect(CVS_BARCODE_IBON.CVSInfo.Barcode2).not.toBe(CVS_BARCODE_FAMILY.CVSInfo.Barcode2);
  });

  it("sends the documented request shape", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    server.use(
      http.post(BARCODE_URL, async ({ request }) => {
        seen.body = await readRequestData(request);
        return HttpResponse.json(envelope(CVS_BARCODE_IBON));
      }),
    );
    await testProvider().getCvsBarcode({ paymentNo: "LLL26213917414", chain: "iBon" });
    expect(seen.body).toEqual({
      MerchantID: MERCHANT,
      PaymentNo: "LLL26213917414",
      CVSType: "iBon",
    });
  });

  it("rejects the two chains ECPay cannot convert", async () => {
    // 28005 lets you 取號 with CVSCode CVS or OK, but 39086 explicitly cannot convert
    // those to barcodes — so the input type is deliberately narrower than the 取號 one.
    for (const chain of ["CVS", "OK"]) {
      const err = (await testProvider()
        .getCvsBarcode({ paymentNo: "LLL1", chain: chain as EcpayCvsBarcodeChain })
        .catch((e: unknown) => e)) as PaymentError;
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toMatch(/不支援轉三段式條碼/);
    }
  });

  it("rejects the wrong casing rather than letting ECPay fail it", async () => {
    // ECPay's value is `iBon`, not `IBON` — the 取號 API uses `IBON`, so getting this
    // backwards is easy.
    await expect(
      testProvider().getCvsBarcode({
        paymentNo: "LLL1",
        chain: "IBON" as EcpayCvsBarcodeChain,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("requires a paymentNo", async () => {
    await expect(
      testProvider().getCvsBarcode({ paymentNo: "", chain: "iBon" }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /paymentNo/ });
  });

  it("surfaces a paid-or-expired order as a business error", async () => {
    // Doc 39086: conversion fails once the order is paid or past its deadline.
    server.use(respondWith(BARCODE_URL, { RtnCode: 10_100_001, RtnMsg: "超商代碼已失效" }));
    const err = (await testProvider()
      .getCvsBarcode({ paymentNo: "LLL1", chain: "iBon" })
      .catch((e: unknown) => e)) as PaymentError;
    expect(err.code).toBe("CONFLICT");
    expect(err.rawCode).toBe("10100001");
  });
});

describe("QueryTradeMedia — downloadTradeMedia", () => {
  const query: EcpayTradeMediaQuery = {
    dateType: "1",
    beginDate: "2026-07-01",
    endDate: "2026-07-31",
  };

  it("returns the recorded CSV verbatim, as text/plain", async () => {
    // Handing back the raw file means a column ECPay adds later cannot be silently
    // dropped — the real file already has one the doc omits.
    server.use(
      http.post(MEDIA_URL, () =>
        HttpResponse.text(TRADE_MEDIA_EMPTY_CSV, {
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    );
    const result = await testProvider().downloadTradeMedia(query);
    expect(result.csv).toBe(TRADE_MEDIA_EMPTY_CSV);
    expect(result.contentType).toContain("text/plain");
  });

  it("treats a header-only body as an empty report, not a failure", async () => {
    server.use(http.post(MEDIA_URL, () => HttpResponse.text(TRADE_MEDIA_EMPTY_CSV)));
    const result = await testProvider().downloadTradeMedia(query);
    expect(parseTradeMediaCsv(result.csv)).toEqual([]);
  });

  it("sends the documented request shape, omitting PaymentType when unset", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    server.use(
      http.post(MEDIA_URL, async ({ request }) => {
        seen.body = await readRequestData(request);
        return HttpResponse.text(TRADE_MEDIA_EMPTY_CSV);
      }),
    );
    await testProvider().downloadTradeMedia(query);
    expect(seen.body).toEqual({
      MerchantID: MERCHANT,
      DateType: "1",
      BeginDate: "2026-07-01",
      EndDate: "2026-07-31",
    });

    await testProvider().downloadTradeMedia({ ...query, paymentType: "04" });
    expect(seen.body).toMatchObject({ PaymentType: "04" });
  });

  it("raises the AES error envelope instead of returning it as report content", async () => {
    // Recorded live once: TransCode 128 "System exception". Whatever it means (not
    // reproducible; see the fixture), the caller must not persist that JSON as a
    // reconciliation file.
    server.use(http.post(MEDIA_URL, () => HttpResponse.json(TRADE_MEDIA_TRANSCODE_128)));
    const err = (await testProvider()
      .downloadTradeMedia(query)
      .catch((e: unknown) => e)) as PaymentError;

    expect(err.code).toBe("PROVIDER");
    expect(err.rawCode).toBe("128");
    expect(err.message).toContain("System exception");
  });

  it("decrypts an inner RtnCode when the error envelope carries Data", async () => {
    server.use(
      http.post(MEDIA_URL, () =>
        HttpResponse.json(envelope({ RtnCode: 10_200_073, RtnMsg: "CheckMacValue error" })),
      ),
    );
    const err = (await testProvider()
      .downloadTradeMedia(query)
      .catch((e: unknown) => e)) as PaymentError;
    expect(err.message).toContain("10200073");
    expect(err.message).toContain("CheckMacValue error");
  });

  it("leaves a CSV that merely starts with a brace alone", async () => {
    // The envelope check is a heuristic on a leading "{"; it must not eat a report.
    const csv = '{not json,"but","csv"}\r\n1,2,3';
    server.use(http.post(MEDIA_URL, () => HttpResponse.text(csv)));
    await expect(testProvider().downloadTradeMedia(query)).resolves.toMatchObject({ csv });
  });

  it("validates DateType", async () => {
    await expect(
      testProvider().downloadTradeMedia({
        ...query,
        dateType: "3" as EcpayTradeMediaQuery["dateType"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /DateType/ });
  });

  it("validates the date format", async () => {
    for (const bad of ["2026/07/01", "20260701", "2026-7-1", ""]) {
      await expect(
        testProvider().downloadTradeMedia({ ...query, beginDate: bad }),
      ).rejects.toMatchObject({ code: "VALIDATION", message: /yyyy-MM-dd/ });
    }
  });

  it("rejects a date that is well-formed but not a real calendar day", async () => {
    // "2026-13-01" passes the yyyy-MM-dd shape check but Date.parse rejects it.
    // Note "2026-02-30" does NOT reach this branch: Date.parse silently rolls it to
    // 2026-03-02, so it fails the range check instead — which is why this test uses
    // an impossible month rather than an impossible day.
    await expect(
      testProvider().downloadTradeMedia({ ...query, beginDate: "2026-13-01" }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /不是有效日期/ });
  });

  it("lets a rolled-over date fall through to the range check", async () => {
    // Documents the surprise above rather than hiding it: 2026-02-30 becomes
    // 2026-03-02, so the failure the caller sees is about the window, not the date.
    await expect(
      testProvider().downloadTradeMedia({ ...query, beginDate: "2026-02-30" }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /1 個月/ });
  });

  it("rejects a swapped range, which ECPay's own doc sample gets wrong", async () => {
    // Doc 41186's example has BeginDate 2022-01-30 with EndDate 2022-01-01. Copying
    // it returns an empty report rather than an error, so catch it locally.
    await expect(
      testProvider().downloadTradeMedia({
        ...query,
        beginDate: "2026-07-31",
        endDate: "2026-07-01",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /不可晚於/ });
  });

  it("rejects a window longer than a month", async () => {
    await expect(
      testProvider().downloadTradeMedia({
        ...query,
        beginDate: "2026-01-01",
        endDate: "2026-06-30",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /1 個月/ });
  });

  it("accepts exactly one month", async () => {
    server.use(http.post(MEDIA_URL, () => HttpResponse.text(TRADE_MEDIA_EMPTY_CSV)));
    await expect(
      testProvider().downloadTradeMedia({
        ...query,
        beginDate: "2026-07-01",
        endDate: "2026-07-31",
      }),
    ).resolves.toBeTruthy();
  });

  it("validates PaymentType against the documented set", async () => {
    await expect(
      testProvider().downloadTradeMedia({
        ...query,
        // Doc 41186's sample passes "01", which is not in its own documented list.
        paymentType: "01" as EcpayTradeMediaQuery["paymentType"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: /PaymentType/ });
  });

  it("maps a transport failure to NETWORK", async () => {
    server.use(http.post(MEDIA_URL, () => HttpResponse.error()));
    await expect(testProvider().downloadTradeMedia(query)).rejects.toMatchObject({
      code: "NETWORK",
      provider: "ecpay-paycode",
    });
  });

  it("maps an HTTP error to PROVIDER with the status as rawCode", async () => {
    // 403 is also how ECPay throttles: doc 45901 says calling too fast returns 403
    // and asks you to back off for 30 minutes.
    server.use(http.post(MEDIA_URL, () => new HttpResponse(null, { status: 403 })));
    await expect(testProvider().downloadTradeMedia(query)).rejects.toMatchObject({
      code: "PROVIDER",
      rawCode: "403",
    });
  });
});

describe("parseTradeMediaCsv", () => {
  it("strips ECPay's Excel armour so cells are usable values", () => {
    // Every cell arrives as `="value"`. Splitting on commas without stripping that
    // gives you keys and values that literally contain `="…"`.
    const rows = parseTradeMediaCsv(TRADE_MEDIA_ONE_ROW_CSV);
    expect(rows).toHaveLength(1);
    expect(rows[0]["特店交易編號"]).toBe("PCATM85542622715");
    expect(rows[0]["交易金額"]).toBe("123");
    expect(JSON.stringify(rows)).not.toContain('="');
  });

  it("takes column names from the file rather than assuming the documented set", () => {
    // The real header has 13 columns; doc 41186 lists 12. Reading row 1 means an
    // added column becomes a new key instead of shifting every value by one.
    const rows = parseTradeMediaCsv(TRADE_MEDIA_ONE_ROW_CSV);
    expect(Object.keys(rows[0])).toEqual([...TRADE_MEDIA_COLUMNS]);
    expect(TRADE_MEDIA_COLUMNS).toContain("金流處理費");
  });

  it("survives an extra column appearing without shifting existing values", () => {
    const csv = '="特店交易編號",="交易金額",="未來新欄位"\r\n="ORDER1",="500",="whatever"\r\n';
    expect(parseTradeMediaCsv(csv)).toEqual([
      { 特店交易編號: "ORDER1", 交易金額: "500", 未來新欄位: "whatever" },
    ]);
  });

  it("returns [] for an empty or header-only file", () => {
    expect(parseTradeMediaCsv("")).toEqual([]);
    expect(parseTradeMediaCsv(TRADE_MEDIA_EMPTY_CSV)).toEqual([]);
  });

  it("handles an empty armoured cell", () => {
    // `=""` is what an empty column looks like once armoured; the capture group is
    // legitimately empty there, which is why unarmour defaults instead of asserting.
    expect(parseTradeMediaCsv('="a",="b"\r\n="",="x"\r\n')).toEqual([{ a: "", b: "x" }]);
  });

  it("tolerates plain unarmoured cells and a missing trailing cell", () => {
    const csv = "a,b,c\r\n1,2\r\n";
    expect(parseTradeMediaCsv(csv)).toEqual([{ a: "1", b: "2", c: "" }]);
  });
});
