import { PaymentError, type PaymentErrorCode } from "@paid-tw/payment";
import { ecpgPost } from "../ecpg/client.js";
import { asNumber, str, text } from "../scalars.js";
import { ECPAY_CREDIT_PATHS, type EcpayCreditQueryConfig, resolveCreditOrigin } from "./config.js";

const PROVIDER = "ecpay-credit";
const MESSAGE_PREFIX = "ECPay 信用卡查詢";

/** One 關帳 (capture) row from 信用卡單筆明細. */
export interface EcpayCreditCloseRecord {
  status?: string;
  amount?: number;
  /** `yyyy/MM/dd HH:mm:ss`. */
  dateTime?: string;
  /** 關帳序號 — returned by the AIO form transport, absent from the AES-JSON docs. */
  sno?: string;
}

/**
 * 信用卡單筆明細紀錄.
 *
 * `status` is ECPay's own vocabulary and its meaning depends on whether capture rows
 * exist: without them it is `Canceled` / `Unauthorized` / `Authorized`; with them,
 * `To be captured` / `Captured` / `Operation canceled`.
 */
export interface EcpayCreditDetail {
  /** 授權單號 (TradeID) — the `gwsr` handle from an authorization or notify. */
  tradeId?: string;
  amount?: number;
  /** 已關帳金額. */
  closedAmount?: number;
  /** 訂單成立時間, `yyyy/MM/dd HH:mm:ss`. */
  authTime?: string;
  status?: string;
  /** Always an array here — ECPay sends `{}` rather than `[]` when there are none. */
  closeData: EcpayCreditCloseRecord[];
  raw: Record<string, unknown>;
}

export interface EcpayCreditDetailInput {
  /** 特店交易編號. Required. */
  merTradeNo: string;
  /**
   * 綠界交易編號. Optional, and the way to reach authorizations **after the first** on
   * a 定期定額 order — obtain it from the periodic order query.
   */
  tradeNo?: string;
}

export interface EcpayCardIssuerInfo {
  issuingBank?: string;
  issuingBankCode?: string;
  /** 聯名卡 details, when the BIN maps to one. */
  coBranding: { code?: string; comment?: string }[];
  raw: Record<string, unknown>;
}

export interface EcpayCardInfoInput {
  /**
   * **First 6-9 digits only** — a BIN prefix, not a full card number. ECPay pads to 9
   * with trailing zeros if you give fewer.
   *
   * This is why the card-issuer lookup is not part of the raw-PAN subpath: a BIN range
   * identifies an issuer, not a cardholder, so it does not carry the PCI weight a full
   * PAN does. Passing a complete card number here would be both wrong and needless.
   */
  cardNoPrefix: string;
}

/**
 * Query 信用卡單筆明細紀錄 (`CreditDetail/QueryTrade`) on the `ecpayment` host.
 *
 * Reachable from both product lines — ECPay documents this endpoint twice, as ECPG
 * doc 9088 and 幕後授權 doc 45925 — so it is exported as a standalone function rather
 * than bolted onto one adapter. Takes no card data.
 *
 * Useful when a ReturnURL notify never arrived: ECPay suggests querying if the result
 * has not landed within 10 minutes. A `error_nopay` result means the bank has not
 * replied yet and is **retryable** — wait another 10 minutes rather than treating the
 * order as failed. It surfaces as a CONFLICT so it is distinguishable from a real miss.
 *
 * @see https://developers.ecpay.com.tw/45925
 */
export async function queryEcpayCreditDetail(
  config: EcpayCreditQueryConfig,
  input: EcpayCreditDetailInput,
): Promise<EcpayCreditDetail> {
  const { merchantId } = requireCredentials(config);
  if (!input.merTradeNo) {
    throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} 需要 merTradeNo`, PROVIDER);
  }

  const decoded = await post(
    config,
    ECPAY_CREDIT_PATHS.creditDetailQueryTrade,
    "QueryCreditDetail",
    {
      MerchantID: merchantId,
      MerchantTradeNo: input.merTradeNo,
      ...(input.tradeNo ? { TradeNo: input.tradeNo } : {}),
    },
  );

  assertCreditDetailOk(decoded);
  return normalizeCreditDetail(decoded);
}

/**
 * Query 信用卡發卡行 (`Credit/QueryCardInfo`) from a **BIN prefix**.
 *
 * @see https://developers.ecpay.com.tw/49623
 */
export async function queryEcpayCardInfo(
  config: EcpayCreditQueryConfig,
  input: EcpayCardInfoInput,
): Promise<EcpayCardIssuerInfo> {
  const { merchantId } = requireCredentials(config);
  const prefix = normalizeCardPrefix(input.cardNoPrefix);

  const decoded = await post(config, ECPAY_CREDIT_PATHS.queryCardInfo, "QueryCardInfo", {
    MerchantID: merchantId,
    CardNo: prefix,
  });

  if (Number(decoded.RtnCode) !== 1) {
    const rawCode = str(decoded.RtnCode) || undefined;
    const rtnMsg = str(decoded.RtnMsg);
    const mapped = rawCode ? CARD_INFO_ERRORS[rawCode] : undefined;
    throw new PaymentError(
      mapped?.code ?? "PROVIDER",
      `${MESSAGE_PREFIX} QueryCardInfo 失敗 (RtnCode=${rawCode ?? "?"}): ` +
        ([mapped?.message, rtnMsg].filter(Boolean).join(" / ") || "未知錯誤"),
      PROVIDER,
      { rawCode, rawMessage: rtnMsg || mapped?.message, raw: decoded },
    );
  }

  const cardInfo = asRecord(decoded.CardInfo);
  const coBranding = Array.isArray(decoded.CoBrandingInfo)
    ? (decoded.CoBrandingInfo as unknown[]).map((row) => {
        const r = asRecord(row);
        return { code: text(r.CoBrandingCode), comment: text(r.Comment) };
      })
    : [];

  return {
    issuingBank: text(cardInfo.IssuingBank),
    issuingBankCode: text(cardInfo.IssuingBankCode),
    coBranding,
    raw: decoded,
  };
}

/**
 * Verified against the 閘道商 stage merchant 2026-08-01.
 *
 * `5000095` is the one worth mapping precisely: this endpoint is 閘道商-only
 * («本功能限閘道商可以申請使用»), and an ordinary merchant gets
 * "Only support gateway merchantID" — a capability problem, not a request problem, so
 * retrying or fixing the payload will never help.
 *
 * `0` / 「查詢失敗」 is what an unrecognised BIN returns. ECPay reuses `0` as a generic
 * failure code, so read it as "no issuer matched this prefix" rather than proof that a
 * card is invalid.
 */
const CARD_INFO_ERRORS: Record<string, { code: PaymentErrorCode; message: string }> = {
  "5000095": { code: "UNSUPPORTED", message: "此 API 限閘道商使用（本特店非閘道商）" },
  "0": { code: "NOT_FOUND", message: "查無此卡號區段的發卡行" },
};

/**
 * ECPay wants 6-9 digits, zero-padded to 9. Rejects anything longer so a full card
 * number cannot be sent here by accident — that would put a PAN on the wire for a
 * lookup that only needs the issuer range.
 *
 * ⚠️ Padding is **not** semantically neutral, despite the doc telling you to do it.
 * Verified: `431195222` returns a 聯名卡 entry while the padded `431195` → `431195000`
 * returns none, so digits 7-9 select a co-branded product. Pass all nine when you have
 * them; a 6-digit BIN answers the issuer question but not the product one.
 */
function normalizeCardPrefix(input: string): string {
  const digits = str(input);
  if (!/^\d{6,9}$/.test(digits)) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} cardNoPrefix 需為 6-9 碼數字（卡號前 9 碼；收到 ${digits.length} 個字元）。` +
        "此 API 只需發卡行區段，請勿傳完整卡號",
      PROVIDER,
    );
  }
  return digits.padEnd(9, "0");
}

/**
 * Legacy protocol from doc 45925: no `RtnCode` at all, failure signalled by one of
 * these strings in `RtnMsg`. Kept because the doc specifies it, but see
 * {@link DETAIL_CODE_ERRORS} — stage actually answers the other way.
 */
const DETAIL_MSG_ERRORS: Record<string, { code: PaymentErrorCode; message: string }> = {
  error_Stop: { code: "AUTH", message: "查無商家或商家已到期" },
  error_nopay: { code: "CONFLICT", message: "銀行尚未回覆授權結果，請 10 分鐘後重查" },
  error: { code: "PROVIDER", message: "查詢失敗或資料檢核失敗" },
};

/**
 * What stage really returns. Verified 2026-08-01: an unknown order comes back as
 * `{ RtnCode: 10000185, RtnMsg: "Cant not find the trade data" }` — an `RtnCode`,
 * which doc 45925 does not mention for this endpoint at all.
 *
 * Same 10000185 the 幕後取號 and 幕後授權 queries use for 查無交易資料, so the meaning is
 * at least consistent across the `ecpayment` host.
 */
const DETAIL_CODE_ERRORS: Record<string, { code: PaymentErrorCode; message: string }> = {
  "10000185": { code: "NOT_FOUND", message: "查無交易資料" },
};

/**
 * This endpoint has **two error protocols** and success uses neither: a successful
 * response carries `RtnMsg: ""` and no `RtnCode` whatsoever.
 *
 * So the presence of `RtnCode` is itself the signal that we are on the modern error
 * path; otherwise fall back to the documented `RtnMsg` strings.
 */
function assertCreditDetailOk(decoded: Record<string, unknown>): void {
  if (decoded.RtnCode !== undefined && Number(decoded.RtnCode) !== 1) {
    const rawCode = str(decoded.RtnCode);
    const mapped = DETAIL_CODE_ERRORS[rawCode];
    const rtnMsg = str(decoded.RtnMsg);
    throw new PaymentError(
      mapped?.code ?? "PROVIDER",
      `${MESSAGE_PREFIX} QueryCreditDetail 失敗 (RtnCode=${rawCode}): ` +
        ([mapped?.message, rtnMsg].filter(Boolean).join(" / ") || "未知錯誤"),
      PROVIDER,
      { rawCode, rawMessage: rtnMsg || mapped?.message, raw: decoded },
    );
  }

  const msg = str(decoded.RtnMsg);
  if (msg) {
    const mapped = DETAIL_MSG_ERRORS[msg];
    throw new PaymentError(
      mapped?.code ?? "PROVIDER",
      `${MESSAGE_PREFIX} QueryCreditDetail 失敗 (${msg})` + (mapped ? `: ${mapped.message}` : ""),
      PROVIDER,
      { rawCode: msg, rawMessage: msg, raw: decoded },
    );
  }

  if (decoded.RtnValue === undefined || decoded.RtnValue === null) {
    throw new PaymentError(
      "NOT_FOUND",
      `${MESSAGE_PREFIX} QueryCreditDetail 回應成功但沒有 RtnValue`,
      PROVIDER,
      { raw: decoded },
    );
  }
}

/**
 * Reads either casing. The AIO form transport returns `amount` / `clsamt` / `authtime`
 * / `close_data` / `sno`, while the AES-JSON docs specify `Amount` / `ClsAmt` /
 * `AuthTime` / `CloseData` / `DateTime` for the same fields — so the normalizer accepts
 * both rather than betting on one.
 */
function normalizeCreditDetail(decoded: Record<string, unknown>): EcpayCreditDetail {
  const v = asRecord(decoded.RtnValue);
  // `CloseData` sits **beside** RtnValue at the top level, not inside it — verified
  // against stage; doc 45925 lists it among the Data params without showing the
  // nesting, and reading it from RtnValue silently yields an empty list forever.
  // Checked in both places so a future move does not break it.
  // ECPay sends `{}` (not `[]`) when there are no rows, so `.map()` needs the guard.
  const rows = decoded.CloseData ?? decoded.close_data ?? v.CloseData ?? v.close_data;

  return {
    tradeId: text(v.TradeID) ?? text(v.tradeID),
    amount: asNumber(v.Amount ?? v.amount),
    closedAmount: asNumber(v.ClsAmt ?? v.clsamt),
    authTime: text(v.AuthTime ?? v.authtime),
    status: text(v.Status ?? v.status),
    closeData: Array.isArray(rows)
      ? (rows as unknown[]).map((row) => {
          const r = asRecord(row);
          return {
            status: text(r.Status ?? r.status),
            amount: asNumber(r.Amount ?? r.amount),
            dateTime: text(r.DateTime ?? r.datetime),
            sno: text(r.SNO ?? r.sno),
          };
        })
      : [],
    raw: decoded,
  };
}

async function post(
  config: EcpayCreditQueryConfig,
  path: string,
  label: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { merchantId, hashKey, hashIv } = requireCredentials(config);
  return ecpgPost<Record<string, unknown>>({
    url: `${resolveCreditOrigin(config)}${path}`,
    merchantId,
    hashKey,
    hashIv,
    data: config.platformId ? { PlatformID: config.platformId, ...data } : data,
    label,
    provider: PROVIDER,
    messagePrefix: MESSAGE_PREFIX,
  });
}

function requireCredentials(config: EcpayCreditQueryConfig) {
  const { merchantId, hashKey, hashIv } = config;
  if (!merchantId || !hashKey || !hashIv) {
    throw new PaymentError("AUTH", "缺少 ECPay 憑證（MerchantID / HashKey / HashIV）", PROVIDER);
  }
  return { merchantId, hashKey, hashIv };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}
