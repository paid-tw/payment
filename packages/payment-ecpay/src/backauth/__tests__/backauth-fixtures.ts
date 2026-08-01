/**
 * Real 信用卡幕後授權 responses, recorded live from ECPay's stage on 2026-08-01 using
 * the published test card `4311952222222222` / CVV `222`. Decrypted `Data` payloads;
 * the MSW handlers re-encrypt them.
 *
 * Findings that constructed fixtures would have missed:
 *
 *   - **The 3D response carries no `RtnCode` and no `RtnMsg` at all** — just
 *     `ThreeDURL`, `MerchantID`, `MerchantTradeNo`. Doc 45958's 3D section lists
 *     RtnCode/RtnMsg, so code that checks `RtnCode === 1` before looking for
 *     `ThreeDURL` rejects a perfectly good 3DS hand-off. This is the single most
 *     important thing in this file.
 *   - **`MerchantID` is a JSON number on the 3D branch** (`3002607`) and a string on
 *     the authorized branch (`"2000132"`). Same field, same API, two types.
 *   - `OrderResultURL` is **required in practice** — omitting it returns
 *     `RtnCode 5000029 "[3D Authorization return URL] Format is incorrect."` even on
 *     a merchant with 3D switched off, though the doc does not mark it 必填.
 *   - A declined card returns **`RtnCode 10100058`**, which in the 幕後取號 code table
 *     means "ATM 繳費期限已過" — the same number means completely different things in
 *     different ECPay services, so error tables must stay per-service. Its message
 *     also embeds a diagnostic shortlink.
 *   - `IssuingBank` is English on stage (`"CTBC Bank"`), not the Chinese name the doc
 *     sample shows. `ChargeFee` is fractional; `ProcessFee` is present.
 *   - `Eci: 0` on the no-3D path (doc: 5/6/2/1 indicate a 3D transaction).
 *
 * Re-record:
 *   ECPAY_LIVE=1 PAID_DEBUG=1 pnpm test:live:ecpay:backauth
 */

/** Direct authorization on the no-3D merchant 2000132. */
export const AUTH_SUCCESS = {
  RtnCode: 1,
  RtnMsg: "Succeeded.",
  MerchantID: "2000132",
  PlatformID: "",
  OrderInfo: {
    MerchantTradeNo: "BAOK85547852370",
    TradeNo: "2608010930520281",
    PaymentDate: "2026/08/01 09:30:53",
    TradeAmt: 199,
    PaymentType: "Credit",
    TradeDate: "2026/08/01 09:30:52",
    ChargeFee: 4.98,
    TradeStatus: "1",
    ProcessFee: 1,
  },
  CardInfo: {
    AuthCode: "777777",
    Gwsr: 14_521_552,
    ProcessDate: "2026/08/01 09:30:53",
    Amount: 199,
    Eci: 0,
    Card6No: "431195",
    Card4No: "2222",
    IssuingBank: "CTBC Bank",
    IssuingBankCode: "822",
  },
  CustomField: "",
  CoBrandingInfo: [],
} as const;

/**
 * 3DS hand-off on merchant 3002607. Note what is **absent**: no RtnCode, no RtnMsg,
 * no OrderInfo — and `MerchantID` is a number here.
 */
export const AUTH_3DS = {
  ThreeDURL: "https://cc-stage.ecpay.com.tw/Payment/SendAuth?t=4F70522872353534B30E9B85A90EAE03",
  MerchantID: 3_002_607,
  MerchantTradeNo: "BA3D85547853850",
} as const;

/** Missing `OrderResultURL`, before the adapter began catching it locally. */
export const AUTH_MISSING_ORDER_RESULT_URL = {
  RtnCode: 5_000_029,
  RtnMsg: "[3D Authorization return URL] Format is incorrect.",
  PlatformID: "",
  MerchantID: "2000132",
  OrderInfo: { MerchantTradeNo: "BA785547606319" },
  CustomField: "",
} as const;

/**
 * A declined card. `10100058` collides with 幕後取號's "ATM 繳費期限已過" — deliberately
 * left unmapped in the BackAuth error table so the gateway's own wording survives.
 */
export const AUTH_DECLINED = {
  RtnCode: 10_100_058,
  RtnMsg: "Pay Fail.(p.ecpay.com.tw/5DD6AAF)",
  PlatformID: "",
  MerchantID: "2000132",
  OrderInfo: { MerchantTradeNo: "BABAD85547854190" },
  CustomField: "",
} as const;

/** QueryTrade for the authorized order above. */
export const QUERY_TRADE_PAID = {
  RtnCode: 1,
  RtnMsg: "Success!",
  PlatformID: "",
  MerchantID: "2000132",
  CustomField: "",
  OrderInfo: {
    MerchantTradeNo: "BAOK85547852370",
    TradeNo: "2608010930520281",
    TradeAmt: 199,
    PaymentType: "Credit",
    PaymentDate: "2026/08/01 09:30:53",
    TradeDate: "2026/08/01 09:30:52",
    TradeStatus: "1",
    ChargeFee: 4.98,
  },
} as const;

/**
 * DoAction success. **Doc-derived, not recorded** — ECPay does not expose
 * `Credit/DoAction` on stage at all («測試環境：因無法提供實際授權，故無法使用此API»),
 * so this shape comes from doc 45919's response field list. The adapter refuses to
 * call the endpoint against a sandbox origin, so nothing here is live-verifiable
 * without production credentials.
 */
export const DOACTION_OK = {
  RtnCode: 1,
  RtnMsg: "Success",
  PlatformID: "",
  MerchantID: "2000132",
  MerchantTradeNo: "BAOK85547852370",
  TradeNo: "2608010930520281",
} as const;

// --- 定期定額 -------------------------------------------------------------------
//
// Recorded 2026-08-01 from stage merchant 2000132 by running one full lifecycle
// (create → query → Cancel → ReAuth) on the *smallest legal schedule*: PeriodType `Y`,
// Frequency 1, ExecTimes 2, amount 5 TWD, cancelled immediately. Findings:
//
//   - **`ExecTimes` minimum is 2, not 1.** Doc 9093 gives ranges (2-999 / 2-99) that
//     read as typos next to Frequency's 1-based ranges, but 1 is genuinely rejected.
//     Caught by deliberately probing out-of-range values, which the adapter now blocks
//     before the network — see the 10100223-10100228 mappings.
//   - **Cycle 1 charges immediately at create time.** The create response already
//     carries `TotalSuccessTimes: 1` and a `Gwsr`, so `execTimes: 2` means "now plus
//     one more", not "two future charges". Anyone testing this pays for cycle 1.
//   - **`ExecLog` is undocumented and is the only per-cycle history.** Doc 9093's
//     field list omits it entirely. The counters say how many cycles succeeded; only
//     this says which, when, for how much, and under which `TradeNo` — each cycle gets
//     its own. Reconciliation needs exactly this.
//   - **`ExecStatus` is undocumented and is the schedule's active flag.** `"1"` while
//     running, `"0"` after `Cancel` — pinned by querying the same orders before and
//     after. `TradeStatus` cannot substitute: it stays `"1"` (paid) on a cancelled
//     schedule because cycle 1 really was charged.
//   - **Period progress arrives inside `CardInfo`**, not a container of its own,
//     alongside the ordinary card fields.
//   - `Cancel` succeeds with the Chinese `RtnMsg: "停用成功"` while ordinary BackAuth
//     success is the English `"Succeeded."` — same service, mixed languages, so no code
//     may match on message text.
//   - **`Cancel` is irreversible**: a later `ReAuth` is `100006 "該訂單狀態為停用中"`.
//     There is no resume endpoint.

/** Order ids of the two cancelled stage schedules these fixtures were recorded from. */
export const STAGE_PERIOD_ORDER_IDS = ["PD85599312928", "PD85599355842"] as const;

/**
 * Create response for a 定期定額 order. Note this is the *same* shape as
 * {@link AUTH_SUCCESS} plus the period fields in `CardInfo` — there is no separate
 * period-create endpoint or response envelope.
 */
export const PERIOD_CREATE_SUCCESS = {
  RtnCode: 1,
  RtnMsg: "Succeeded.",
  MerchantID: "2000132",
  PlatformID: "",
  OrderInfo: {
    MerchantTradeNo: "PD85599355842",
    TradeNo: "2608012349160646",
    PaymentDate: "2026/08/01 23:49:16",
    TradeAmt: 5,
    PaymentType: "Credit",
    TradeDate: "2026/08/01 23:49:16",
    ChargeFee: 2,
    TradeStatus: "1",
    ProcessFee: 1,
  },
  CardInfo: {
    AuthCode: "777777",
    Gwsr: 14_522_380,
    ProcessDate: "2026/08/01 23:49:16",
    Amount: 5,
    Eci: 0,
    Card6No: "431195",
    Card4No: "2222",
    IssuingBank: "CTBC Bank",
    IssuingBankCode: "822",
    // The schedule echoed back, and cycle 1 already counted as charged.
    PeriodType: "Y",
    Frequency: 1,
    ExecTimes: 2,
    PeriodAmount: 5,
    TotalSuccessTimes: 1,
    TotalSuccessAmount: 5,
  },
  CustomField: "",
  CoBrandingInfo: [],
} as const;

/** QueryTrade on the schedule while it was still running — `ExecStatus: "1"`. */
export const PERIOD_QUERY_ACTIVE = {
  RtnCode: 1,
  RtnMsg: "Success!",
  PlatformID: "",
  MerchantID: "2000132",
  CustomField: "",
  OrderInfo: {
    MerchantTradeNo: "PD85599355842",
    TradeNo: "2608012349160646",
    TradeAmt: 5,
    PaymentType: "Credit",
    PaymentDate: "2026/08/01 23:49:16",
    TradeDate: "2026/08/01 23:49:16",
    TradeStatus: "1",
    ChargeFee: 2,
    ProcessFee: 1,
    RefundAmount: 0,
  },
  ExecStatus: "1",
  ExecLog: [
    {
      RtnCode: 1,
      Amount: 5,
      Gwsr: 14_522_380,
      ProcessDate: "2026/08/01 23:49:16",
      AuthCode: "777777",
      TradeNo: "2608012349160646",
      ChargeFee: 2,
    },
  ],
  CardInfo: {
    IssuingBank: "CTBC Bank",
    IssuingBankCode: "822",
    PeriodType: "Y",
    Frequency: 1,
    ExecTimes: 2,
    PeriodAmount: 5,
    TotalSuccessTimes: 1,
    TotalSuccessAmount: 5,
    AuthCode: "777777",
    Gwsr: 14_522_380,
    ProcessDate: "2026/08/01 23:49:16",
    Amount: 5,
    Eci: 0,
    Card6No: "431195",
    Card4No: "2222",
  },
  CoBrandingInfo: [],
} as const;

/**
 * The same order after `Cancel`. Only `ExecStatus` moved, 1 → 0 — `TradeStatus` is
 * still `"1"` and the counters are unchanged, which is why `isActive` reads ExecStatus.
 */
export const PERIOD_QUERY_CANCELLED = {
  ...PERIOD_QUERY_ACTIVE,
  ExecStatus: "0",
} as const;

/** `Action: "Cancel"`. Success message is Chinese here, unlike every other endpoint. */
export const PERIOD_CANCEL_SUCCESS = {
  RtnMsg: "停用成功",
  RtnCode: 1,
  MerchantID: "2000132",
  MerchantTradeNo: "PD85599355842",
} as const;

/** `Action: "ReAuth"` on an already-cancelled schedule. Terminal, not retryable. */
export const PERIOD_REAUTH_CANCELLED = {
  RtnCode: 100_006,
  RtnMsg: "該訂單狀態為停用中",
  MerchantID: "2000132",
  MerchantTradeNo: "PD85599355842",
} as const;
