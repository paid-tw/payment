import { PaymentError } from "@paid-tw/payment";
import { computeCheckMacValue } from "./provider.js";

/**
 * Exact body merchants must respond with on {@link ReturnURL} after accepting a
 * payment notify. Case/spacing variants are rejected by ECPay and trigger retries.
 *
 * @see https://developers.ecpay.com.tw/?p=2878
 */
export const ECPAY_NOTIFY_ACK = "1|OK" as const;

/** Raw form fields from ReturnURL / OrderResultURL (all values as strings). */
export type EcpayNotifyBody = Record<string, string>;

/**
 * Loose input accepted by {@link verifyPaymentNotify}: a plain object (e.g. parsed
 * Express `req.body`), `URLSearchParams`, or a raw `a=b&c=d` body string.
 */
export type EcpayNotifyInput =
  | EcpayNotifyBody
  | URLSearchParams
  | string
  | Record<string, string | string[] | undefined | null>;

export interface EcpayNotifyCredentials {
  hashKey: string;
  hashIv: string;
  /** When set, rejects notifies whose MerchantID does not match. */
  merchantId?: string;
}

/**
 * Verified, normalized payment result notification (ReturnURL / OrderResultURL).
 *
 * Callers should:
 * 1. verify the payload (this function)
 * 2. treat {@link EcpayPaymentNotify.success} && !{@link EcpayPaymentNotify.simulated}
 *    as a shippable paid event (still idempotent on merTradeNo)
 * 3. respond with {@link ECPAY_NOTIFY_ACK} on ReturnURL
 */
export interface EcpayPaymentNotify {
  /** `RtnCode === "1"`. */
  success: boolean;
  /**
   * Vendor-console "模擬付款" (`SimulatePaid=1`). Never ship — not a real capture.
   * @see https://developers.ecpay.com.tw/?p=2878
   */
  simulated: boolean;
  merchantId: string;
  merTradeNo: string;
  tradeNo?: string;
  amount?: number;
  /** Normalized family: card / atm / cvs / … */
  method: string;
  paidAt?: string;
  tradeDate?: string;
  rtnCode: string;
  rtnMsg: string;
  storeId?: string;
  paymentTypeChargeFee?: number;
  /**
   * 信用卡授權單號 for {@link import("./provider.js").EcpayProvider.queryCreditTrade}.
   * Present when create used NeedExtraPaidInfo=Y (`gwsr` or `CreditRefundId`).
   */
  creditRefundId?: string;
  customFields?: {
    field1?: string;
    field2?: string;
    field3?: string;
    field4?: string;
  };
  /** Full verified field set (including CheckMacValue). */
  raw: EcpayNotifyBody;
}

/**
 * Verify an AIO payment-result POST (ReturnURL server notify or OrderResultURL
 * browser POST). Parity with PHP `VerifiedArrayResponse` /
 * `example/Payment/Aio/GetCheckoutResponse.php`.
 *
 * @throws {PaymentError} `AUTH` when CheckMacValue is missing/invalid;
 *   `VALIDATION` when required fields are absent or MerchantID mismatches.
 */
export function verifyPaymentNotify(
  input: EcpayNotifyInput,
  credentials: EcpayNotifyCredentials,
): EcpayPaymentNotify {
  const { raw, merchantId, merTradeNo } = assertNotifyAuthentic(input, credentials);
  const rtnCode = raw.RtnCode ?? "";
  const success = rtnCode === "1";
  const simulated = raw.SimulatePaid === "1";

  return {
    success,
    simulated,
    merchantId,
    merTradeNo,
    tradeNo: raw.TradeNo || undefined,
    amount: asNumber(raw.TradeAmt),
    method: mapPaymentType(raw.PaymentType),
    paidAt: raw.PaymentDate || undefined,
    tradeDate: raw.TradeDate || undefined,
    rtnCode,
    rtnMsg: raw.RtnMsg ?? "",
    storeId: raw.StoreID || undefined,
    paymentTypeChargeFee: asNumber(raw.PaymentTypeChargeFee),
    creditRefundId: raw.gwsr || raw.CreditRefundId || undefined,
    customFields: {
      field1: raw.CustomField1 || undefined,
      field2: raw.CustomField2 || undefined,
      field3: raw.CustomField3 || undefined,
      field4: raw.CustomField4 || undefined,
    },
    raw,
  };
}

/**
 * Shared authenticity check for every AIO form notify: CheckMacValue over the whole
 * body, then the identity fields.
 *
 * One owner for this on purpose — the payment-result notify and the take-number notify
 * differ in what they *mean*, not in how they are authenticated, and a second copy is
 * how one path ends up missing a hardening fix.
 */
function assertNotifyAuthentic(
  input: EcpayNotifyInput,
  credentials: EcpayNotifyCredentials,
): { raw: EcpayNotifyBody; merchantId: string; merTradeNo: string } {
  const raw = coerceNotifyBody(input);
  const { hashKey, hashIv, merchantId: expectedMerchantId } = credentials;

  if (!hashKey || !hashIv) {
    throw new PaymentError("AUTH", "缺少 ECPay 憑證（HashKey / HashIV）", "ecpay");
  }

  const returned = raw.CheckMacValue;
  if (!returned) {
    throw new PaymentError("AUTH", "ECPay 通知缺少 CheckMacValue", "ecpay", { raw });
  }

  const expected = computeCheckMacValue(raw, hashKey, hashIv);
  if (expected !== returned.toUpperCase()) {
    throw new PaymentError("AUTH", "ECPay 通知 CheckMacValue 驗證失敗", "ecpay", { raw });
  }

  const merchantId = raw.MerchantID ?? "";
  const merTradeNo = raw.MerchantTradeNo ?? "";
  if (!merchantId || !merTradeNo) {
    throw new PaymentError("VALIDATION", "ECPay 通知缺少 MerchantID 或 MerchantTradeNo", "ecpay", {
      raw,
    });
  }
  if (expectedMerchantId && merchantId !== expectedMerchantId) {
    throw new PaymentError(
      "VALIDATION",
      `ECPay 通知 MerchantID 不符（expected ${expectedMerchantId}, got ${merchantId}）`,
      "ecpay",
      { raw },
    );
  }
  return { raw, merchantId, merTradeNo };
}

/**
 * 取號成功 codes, which are **not** `1`.
 *
 * ATM answers `2` and CVS/BARCODE answer `10100073`. This is the whole reason the
 * take-number notify needs its own verifier: {@link verifyPaymentNotify} reports
 * `success` as `RtnCode === "1"`, so feeding it a perfectly successful 取號 notify
 * yields `success: false`.
 *
 * @see https://developers.ecpay.com.tw/?p=2881
 */
const TAKE_NUMBER_SUCCESS_CODES: ReadonlySet<string> = new Set(["2", "10100073"]);

/**
 * Verified 取號 (payment-code issued) notification from `PaymentInfoURL` /
 * `ClientRedirectURL`.
 *
 * Fires when the **order is created**, not when it is paid — so `success` here means
 * "the consumer now has something to pay with", and the payment itself still arrives
 * later on `ReturnURL`.
 */
export interface EcpayPaymentInfoNotify {
  /** `RtnCode` is one of the 取號成功 codes (`2` for ATM, `10100073` for CVS/BARCODE). */
  success: boolean;
  merchantId: string;
  merTradeNo: string;
  tradeNo?: string;
  amount?: number;
  /** Normalized family: atm / cvs / barcode. */
  method: string;
  tradeDate?: string;
  rtnCode: string;
  rtnMsg: string;
  storeId?: string;
  /** ATM 虛擬帳號. */
  atm?: { bankCode?: string; vAccount?: string; expireDate?: string };
  /** 超商代碼. */
  cvs?: { paymentNo?: string; expireDate?: string };
  /** 超商條碼 — three Code39 segments, no image. */
  barcode?: { barcode1?: string; barcode2?: string; barcode3?: string; expireDate?: string };
  customFields: [string?, string?, string?, string?];
  raw: EcpayNotifyBody;
}

/**
 * Verify an AIO **取號結果通知** (`PaymentInfoURL` server POST, or the query string on
 * `ClientRedirectURL`), then respond with {@link ECPAY_NOTIFY_ACK}.
 *
 * Use this — not {@link verifyPaymentNotify} — for that notify. Same
 * form-encoded + CheckMacValue transport, but different success codes and a different
 * field set: it carries the payment code rather than a payment result.
 *
 * The flow it completes is the one AIO offers as an alternative to
 * 非信用卡幕後取號: the consumer still goes through ECPay's page, but you receive the
 * virtual account / 繳費代碼 / barcode on your server as soon as the order exists.
 *
 * @see https://developers.ecpay.com.tw/?p=2881
 */
export function verifyEcpayPaymentInfoNotify(
  input: EcpayNotifyInput,
  credentials: EcpayNotifyCredentials,
): EcpayPaymentInfoNotify {
  const { raw, merchantId, merTradeNo } = assertNotifyAuthentic(input, credentials);
  const rtnCode = raw.RtnCode ?? "";

  const atm = pick({
    bankCode: raw.BankCode,
    vAccount: raw.vAccount,
    expireDate: raw.ExpireDate,
  });
  const cvs = pick({ paymentNo: raw.PaymentNo, expireDate: raw.ExpireDate });
  const barcode = pick({
    barcode1: raw.Barcode1,
    barcode2: raw.Barcode2,
    barcode3: raw.Barcode3,
    expireDate: raw.ExpireDate,
  });

  return {
    success: TAKE_NUMBER_SUCCESS_CODES.has(rtnCode),
    merchantId,
    merTradeNo,
    tradeNo: raw.TradeNo || undefined,
    amount: asNumber(raw.TradeAmt),
    method: mapPaymentType(raw.PaymentType),
    tradeDate: raw.TradeDate || undefined,
    rtnCode,
    rtnMsg: raw.RtnMsg ?? "",
    storeId: raw.StoreID || undefined,
    // Keyed off the identifying field of each family, so an ATM notify does not report
    // an empty `cvs` object just because ExpireDate is shared between them.
    atm: raw.vAccount ? atm : undefined,
    cvs: raw.PaymentNo ? cvs : undefined,
    barcode: raw.Barcode1 ? barcode : undefined,
    customFields: [
      raw.CustomField1 || undefined,
      raw.CustomField2 || undefined,
      raw.CustomField3 || undefined,
      raw.CustomField4 || undefined,
    ],
    raw,
  };
}

/** Drop empty/absent members so callers never see `{ bankCode: "" }`. */
function pick<T extends Record<string, string | undefined>>(fields: T): T {
  const out = {} as T;
  for (const [key, value] of Object.entries(fields)) {
    if (value) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

/** Coerce framework-agnostic body shapes into a flat string map. */
export function coerceNotifyBody(input: EcpayNotifyInput): EcpayNotifyBody {
  if (typeof input === "string") {
    return Object.fromEntries(new URLSearchParams(input).entries());
  }
  if (input instanceof URLSearchParams) {
    return Object.fromEntries(input.entries());
  }

  const out: EcpayNotifyBody = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? String(value[0] ?? "") : String(value);
  }
  return out;
}

function mapPaymentType(value?: string): string {
  if (!value) return "unknown";
  const family = value.split("_")[0];
  switch (family) {
    case "Credit":
      return "card";
    case "ATM":
      return "atm";
    case "CVS":
      return "cvs";
    case "BARCODE":
      return "barcode";
    case "WebATM":
      return "webatm";
    case "ApplePay":
      return "applepay";
    case "TWQR":
      return "twqr";
    case "BNPL":
      return "bnpl";
    default:
      return family ?? value;
  }
}

function asNumber(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const num = Number(input);
  return Number.isNaN(num) ? undefined : num;
}
