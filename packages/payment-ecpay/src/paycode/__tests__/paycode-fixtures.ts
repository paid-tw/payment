/**
 * Real 非信用卡幕後取號 responses, recorded live from ECPay's public stage merchant
 * {@link import("../../config.js").ECPAY_SANDBOX} (MerchantID 3002607) on
 * 2026-08-01. These are the **decrypted `Data`** payloads; the MSW handlers
 * re-encrypt them with the same HashKey/HashIV the live tests use.
 *
 * Findings that constructed fixtures would have missed:
 *
 *   - **Duplicate MerchantTradeNo is `RtnCode 10300028`**, not the `10200047` that
 *     ECPay's shared code table lists for AIO. The error payload keeps only
 *     `OrderInfo.MerchantTradeNo` and sets `CustomField: null`.
 *   - **A missing order on QueryTrade is `RtnCode 10000185`** ("Cant not find the
 *     trade data"), i.e. an *inner* business code — the envelope still answers
 *     `TransCode: 1`, so a TransCode-only check reports success.
 *   - **QueryTrade and QueryPaymentInfo return different `ATMInfo` shapes.**
 *     QueryTrade gives the *payer* (`ATMAccBank` / `ATMAccNo`, JSON `null` until
 *     someone actually transfers); QueryPaymentInfo gives the *code*
 *     (`BankCode` / `vAccount` / `ExpireDate`). Only the latter can re-display a
 *     virtual account.
 *   - QueryTrade carries undocumented `ProcessFee` and `RefundAmount`;
 *     QueryPaymentInfo omits both.
 *   - `ChargeFee` is **not** an integer despite the doc's `Int` — ATM at 123 元
 *     billed `1.23`.
 *   - `Barcode1` is **not** "9 碼數字" as 28025 claims: real value `1508086CY`
 *     ends in letters. Parsing it as numeric would break.
 *   - `RtnMsg` is `"成功"` on GenPaymentCode but `"Success!"` on the queries, and
 *     the outer `TransMsg` is `"Success!"` (with the bang) — never match on these.
 *   - Omitting `ATMBankCode` got bank `004`; asking for `822` got `822`, so the
 *     hint is honoured rather than ignored.
 *
 * Re-record:
 *   ECPAY_LIVE=1 PAID_DEBUG=1 pnpm test:live:ecpay:paycode
 */

/** ATM 取號 with `atmBankCode: "822"` and a custom field. TradeStatus 0 = unpaid. */
export const GEN_ATM = {
  RtnCode: 1,
  RtnMsg: "成功",
  PlatformID: "",
  MerchantID: "3002607",
  OrderInfo: {
    MerchantTradeNo: "PCATM85542622715",
    TradeNo: "2608010803430236",
    PaymentDate: "",
    TradeAmt: 123,
    PaymentType: "ATM",
    TradeDate: "2026/08/01 08:03:43",
    ChargeFee: 1.23,
    TradeStatus: "0",
  },
  ATMInfo: {
    BankCode: "822",
    vAccount: "9251262164875291",
    ExpireDate: "2026/08/04",
  },
  CustomField: "paid-tw-live",
} as const;

/** CVS 取號 with `expireDate: 6000` minutes → expiry ~4 days out, plus a mobile page. */
export const GEN_CVS = {
  RtnCode: 1,
  RtnMsg: "成功",
  PlatformID: "",
  MerchantID: "3002607",
  OrderInfo: {
    MerchantTradeNo: "PCCVS85542623066",
    TradeNo: "2608010803430237",
    PaymentDate: "",
    TradeAmt: 456,
    PaymentType: "CVS",
    TradeDate: "2026/08/01 08:03:43",
    ChargeFee: 26,
    TradeStatus: "0",
  },
  CVSInfo: {
    PaymentNo: "LLL26213917389",
    ExpireDate: "2026/08/05 12:03:43",
    PaymentURL:
      "https://payment-stage.ecpay.com.tw/PaymentRule/CVSBarCode?PaymentNo=LLL26213917389",
  },
  CustomField: "",
} as const;

/** BARCODE 取號, 7 days. Note Barcode1 carries letters. */
export const GEN_BARCODE = {
  RtnCode: 1,
  RtnMsg: "成功",
  PlatformID: "",
  MerchantID: "3002607",
  OrderInfo: {
    MerchantTradeNo: "PCBAR85542625818",
    TradeNo: "2608010803460238",
    PaymentDate: "",
    TradeAmt: 789,
    PaymentType: "BARCODE",
    TradeDate: "2026/08/01 08:03:46",
    ChargeFee: 15,
    TradeStatus: "0",
  },
  BarcodeInfo: {
    Barcode1: "1508086CY",
    Barcode2: "1557352207269145",
    Barcode3: "080829000000789",
    ExpireDate: "2026/08/08 23:59:59",
  },
  CustomField: "",
} as const;

/** ATM 取號 with no `atmBankCode` → ECPay picked 004. Basis for the query fixtures. */
export const GEN_ATM_DEFAULT_BANK = {
  RtnCode: 1,
  RtnMsg: "成功",
  PlatformID: "",
  MerchantID: "3002607",
  OrderInfo: {
    MerchantTradeNo: "PCQRY85542626369",
    TradeNo: "2608010803460239",
    PaymentDate: "",
    TradeAmt: 100,
    PaymentType: "ATM",
    TradeDate: "2026/08/01 08:03:46",
    ChargeFee: 1,
    TradeStatus: "0",
  },
  ATMInfo: {
    BankCode: "004",
    vAccount: "3833846216926530",
    ExpireDate: "2026/08/04",
  },
  CustomField: "",
} as const;

/** Order id shared by {@link QUERY_TRADE_UNPAID} / {@link QUERY_INFO_ATM}. */
export const STAGE_QUERY_MER_TRADE_NO = GEN_ATM_DEFAULT_BANK.OrderInfo.MerchantTradeNo;

/**
 * QueryTrade for that unpaid ATM order. `ATMInfo` here describes the **payer** and
 * is `null`/`null` until a transfer happens — it never carries the virtual account.
 */
export const QUERY_TRADE_UNPAID = {
  RtnCode: 1,
  RtnMsg: "Success!",
  PlatformID: "",
  MerchantID: "3002607",
  CustomField: "",
  OrderInfo: {
    MerchantTradeNo: "PCQRY85542626369",
    TradeNo: "2608010803460239",
    TradeAmt: 100,
    PaymentType: "ATM",
    PaymentDate: "",
    TradeDate: "2026/08/01 08:03:46",
    TradeStatus: "0",
    ChargeFee: 1,
    ProcessFee: 0,
    RefundAmount: 0,
  },
  ATMInfo: { ATMAccBank: null, ATMAccNo: null },
} as const;

/** QueryPaymentInfo for the same order — this is where the virtual account lives. */
export const QUERY_INFO_ATM = {
  RtnCode: 1,
  RtnMsg: "Success!",
  PlatformID: "",
  MerchantID: "3002607",
  CustomField: "",
  OrderInfo: {
    MerchantTradeNo: "PCQRY85542626369",
    TradeNo: "2608010803460239",
    TradeAmt: 100,
    PaymentType: "ATM",
    PaymentDate: "",
    TradeDate: "2026/08/01 08:03:46",
    TradeStatus: "0",
    ChargeFee: 1,
  },
  ATMInfo: {
    BankCode: "004",
    vAccount: "3833846216926530",
    ExpireDate: "2026/08/04",
  },
} as const;

/** Re-posting a MerchantTradeNo ECPay already knows. */
export const GEN_DUPLICATE_ORDER = {
  RtnCode: 10_300_028,
  RtnMsg: "Creation failed due to duplicate order number",
  PlatformID: "",
  MerchantID: "3002607",
  OrderInfo: { MerchantTradeNo: "PCDUP85542627152" },
  CustomField: null,
} as const;

/** QueryTrade for an order that never existed — note how sparse the payload is. */
export const QUERY_TRADE_NOT_FOUND = {
  RtnCode: 10_000_185,
  RtnMsg: "Cant not find the trade data",
} as const;
