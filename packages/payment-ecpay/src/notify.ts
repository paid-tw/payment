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
  const raw = coerceNotifyBody(input);
  const { hashKey, hashIv, merchantId: expectedMerchantId } = credentials;

  if (!hashKey || !hashIv) {
    throw new PaymentError("AUTH", "缺少 ECPay 憑證（HashKey / HashIV）", "ecpay");
  }

  const returned = raw.CheckMacValue;
  if (!returned) {
    throw new PaymentError("AUTH", "ECPay 付款通知缺少 CheckMacValue", "ecpay", { raw });
  }

  const expected = computeCheckMacValue(raw, hashKey, hashIv);
  if (expected !== returned.toUpperCase()) {
    throw new PaymentError("AUTH", "ECPay 付款通知 CheckMacValue 驗證失敗", "ecpay", {
      raw,
    });
  }

  const merchantId = raw.MerchantID ?? "";
  const merTradeNo = raw.MerchantTradeNo ?? "";
  if (!merchantId || !merTradeNo) {
    throw new PaymentError(
      "VALIDATION",
      "ECPay 付款通知缺少 MerchantID 或 MerchantTradeNo",
      "ecpay",
      { raw },
    );
  }
  if (expectedMerchantId && merchantId !== expectedMerchantId) {
    throw new PaymentError(
      "VALIDATION",
      `ECPay 付款通知 MerchantID 不符（expected ${expectedMerchantId}, got ${merchantId}）`,
      "ecpay",
      { raw },
    );
  }

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
    customFields: {
      field1: raw.CustomField1 || undefined,
      field2: raw.CustomField2 || undefined,
      field3: raw.CustomField3 || undefined,
      field4: raw.CustomField4 || undefined,
    },
    raw,
  };
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
