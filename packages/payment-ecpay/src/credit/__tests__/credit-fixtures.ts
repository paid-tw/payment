/**
 * Real credit-query responses, recorded from ECPay stage on 2026-08-01 by probing
 * every branch we could reach. Decrypted `Data` payloads; MSW re-encrypts them.
 *
 * `CreditDetail/QueryTrade` findings — doc 45925 is wrong or silent on all of these:
 *
 *   - **`CloseData` is a top-level sibling of `RtnValue`, not nested inside it.** The
 *     doc lists it among the Data params without showing nesting; reading it from
 *     `RtnValue` yields an empty list forever and no test would notice.
 *   - **Failure comes back as an `RtnCode`, which the doc never mentions for this
 *     endpoint.** An unknown order is `{ RtnCode: 10000185, RtnMsg: "Cant not find
 *     the trade data" }`. The doc describes a completely different protocol —
 *     `RtnMsg` set to `error_Stop` / `error_nopay` / `error` with no RtnCode. Both are
 *     handled; only the RtnCode one has been observed.
 *   - **Success carries neither** — `RtnMsg: ""` and no `RtnCode` at all. So the mere
 *     presence of `RtnCode` is the signal that you are on the error path.
 *   - Field casing is **PascalCase** here (`Amount`/`ClsAmt`/`AuthTime`), while the AIO
 *     form transport returns the same data as `amount`/`clsamt`/`authtime`/`close_data`.
 *     Same logical endpoint, two casings.
 *   - `TradeID` equals the `Gwsr` from the original authorization, confirming they are
 *     the same 授權單號.
 *   - Passing `TradeNo` alongside `MerchantTradeNo` changed nothing for a single-payment
 *     order — it is for reaching later authorizations on a 定期定額 order.
 *   - An unknown order, a **non-credit** order (ATM 取號), and a valid order queried
 *     under the **wrong merchant** all return the identical 10000185. You cannot tell
 *     "not mine" from "not a credit order" from the response.
 *
 * `Credit/QueryCardInfo` findings:
 *
 *   - **閘道商-only.** Ordinary stage merchants get `5000095 "Only support gateway
 *     merchantID"`. Doc 49623 does say 「本功能限閘道商可以申請使用」 — easy to miss, and
 *     the failure is a capability problem no payload fix will solve.
 *   - **Zero-padding a short prefix is not semantically neutral**, even though the doc
 *     tells you to pad. `431195222` returns a 聯名卡 entry; the padded `431195` →
 *     `431195000` returns none. Digits 7-9 select a co-branded product.
 *   - An unrecognised BIN is `RtnCode: 0` / 「查詢失敗」 — a generic code reused for
 *     failure, so read it as "no issuer matched", not "invalid card".
 *   - Success has `RtnMsg: ""` even though `RtnCode` is 1.
 *
 * Re-record:
 *   ECPAY_LIVE=1 PAID_DEBUG=1 pnpm test:live:ecpay:credit
 */

/** Order id + gateway trade no of the recorded stage authorization. */
export const STAGE_CREDIT_MER_TRADE_NO = "BAOK85547852370";
export const STAGE_CREDIT_TRADE_NO = "2608010930520281";

/**
 * Authorized-but-not-captured single payment (`directCapture: false`).
 * `ClsAmt: 0` and `CloseData: {}` are the observable form of "not captured yet".
 */
export const DETAIL_AUTHORIZED = {
  RtnMsg: "",
  RtnValue: {
    TradeID: 14_521_552,
    Amount: 199,
    ClsAmt: 0,
    AuthTime: "2026/08/01 09:30:52",
    Status: "Authorized",
  },
  CloseData: {},
} as const;

/**
 * A captured order, i.e. `CloseData` as a populated array. **Doc-derived, not
 * recorded**: capturing needs `Credit/DoAction`, which ECPay does not expose on stage
 * at all, so we cannot produce this shape there. Row fields follow doc 45925
 * (`Status` / `Amount` / `DateTime`); the AIO transport additionally sends `sno`.
 */
export const DETAIL_CAPTURED = {
  RtnMsg: "",
  RtnValue: {
    TradeID: 14_521_552,
    Amount: 199,
    ClsAmt: 199,
    AuthTime: "2026/08/01 09:30:52",
    Status: "Captured",
  },
  CloseData: [
    { Status: "Captured", Amount: 199, DateTime: "2026/08/02 03:00:00" },
    { Status: "To be captured", Amount: 0, DateTime: "2026/08/01 09:30:52" },
  ],
} as const;

/**
 * The same payload as the AIO form transport spells it — lowercase keys plus `sno`.
 * Included so the normalizer's casing tolerance is pinned by a test rather than only
 * by a comment.
 */
export const DETAIL_AIO_CASING = {
  RtnMsg: "",
  RtnValue: {
    TradeID: 14_521_552,
    amount: 199,
    clsamt: 199,
    authtime: "2026/08/01 09:30:52",
    status: "Captured",
    close_data: [{ status: "Captured", amount: 199, datetime: "2026/08/02 03:00:00", sno: "1" }],
  },
} as const;

/** Unknown order id. Identical for a non-credit order and for the wrong merchant. */
export const DETAIL_NOT_FOUND = {
  RtnCode: 10_000_185,
  RtnMsg: "Cant not find the trade data",
} as const;

// --- Credit/QueryCardInfo -------------------------------------------------------

/** 9-digit prefix on the 閘道商 merchant — note the 聯名卡 entry. */
export const CARD_INFO_WITH_COBRANDING = {
  RtnCode: 1,
  RtnMsg: "",
  MerchantID: "3085779",
  PlatformID: "",
  CardInfo: { IssuingBank: "中國信託", IssuingBankCode: "822" },
  CoBrandingInfo: [{ CoBrandingCode: "ABCTest", Comment: "APP SDK測試" }],
} as const;

/** Same card, 6-digit prefix zero-padded to 9 — the 聯名卡 entry disappears. */
export const CARD_INFO_PADDED = {
  RtnCode: 1,
  RtnMsg: "",
  MerchantID: "3085779",
  PlatformID: "",
  CardInfo: { IssuingBank: "中國信託", IssuingBankCode: "822" },
  CoBrandingInfo: [],
} as const;

/** Non-gateway merchant. A capability failure — no payload change helps. */
export const CARD_INFO_NOT_GATEWAY = {
  RtnCode: 5_000_095,
  RtnMsg: "Only support gateway merchantID",
} as const;

/** Unrecognised BIN. ECPay reuses `0` generically. */
export const CARD_INFO_UNKNOWN_BIN = {
  RtnCode: 0,
  RtnMsg: "查詢失敗",
} as const;
