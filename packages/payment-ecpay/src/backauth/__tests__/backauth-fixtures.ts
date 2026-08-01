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
