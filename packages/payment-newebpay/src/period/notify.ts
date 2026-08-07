import { PaymentError } from "@paid-tw/payment";
import { decryptTradeInfo } from "../crypto.js";
import {
  coerceNewebpayNotifyBody,
  extractResult,
  parseDecryptedPayload,
  type NewebpayNotifyCredentials,
  type NewebpayNotifyInput,
} from "../notify.js";

/**
 * 定期定額 notify verification (NDNP-1.0.7 §4.3.2 / §4.3.3).
 *
 * The periodic line's envelope is a single AES-encrypted field — `Period`
 * (create result, N050) or `period` (AlterStatus response prints it lowercase)
 * — with **no TradeSha**: successful decryption under the merchant's
 * HashKey/HashIV is the only integrity check the gateway provides.
 *
 * Two different payloads arrive on the mandate's URLs:
 * - the **create result** (ReturnURL redirect + NotifyURL POST) after the
 *   consumer finishes the hosted card page — {@link verifyPeriodCreateNotify};
 * - the **each-period result** [NPA-N050] on every scheduled charge, success
 *   or failure — {@link verifyPeriodCycleNotify}. Delivery may be
 *   `application/x-www-form-urlencoded` OR `multipart/form-data`; parse the
 *   body accordingly before passing it here.
 */

/** Mandate-creation result. `auth` is present when PeriodStartType 1/2 ran a card auth. */
export interface NewebpayPeriodCreateNotify {
  /** Decrypted `Status === "SUCCESS"` — mandate created (and P1 authorized when applicable). */
  success: boolean;
  status: string;
  message: string;
  merchantId: string;
  /** MerOrderNo echoed back as MerchantOrderNo. */
  merTradeNo: string;
  /** NewebPay mandate id (`P…`) — required for AlterStatus / AlterAmt. */
  periodNo?: string;
  periodType?: string;
  /** Total scheduled periods. */
  authTimes?: number;
  /** Every scheduled auth date, `YYYY-MM-DD`. */
  dateArray: string[];
  periodAmt?: number;
  /** First-auth details (PeriodStartType 1 or 2 only). */
  auth?: {
    authTime?: string;
    tradeNo?: string;
    /** Masked, e.g. `400022******1111`. */
    cardNo?: string;
    authCode?: string;
    /** `00` = bank approved. */
    respondCode?: string;
    escrowBank?: string;
    authBank?: string;
    paymentMethod?: string;
  };
  raw: { envelope: Record<string, string>; decrypted: Record<string, unknown> };
}

/** Each-period authorization result [NPA-N050]. Fires on failures too. */
export interface NewebpayPeriodCycleNotify {
  /** Decrypted `Status === "SUCCESS"` — this period's auth succeeded. */
  success: boolean;
  status: string;
  message: string;
  merchantId: string;
  merTradeNo: string;
  /** Per-period order id: `MerchantOrderNo_期數` (e.g. `order123_2`). */
  orderNo?: string;
  /** The period number parsed from {@link orderNo}'s `_n` suffix. */
  periodSequence?: number;
  /** This period's own NewebPay trade serial (refund it via the MPG provider). */
  tradeNo?: string;
  authDate?: string;
  /** Total periods of the mandate. */
  totalTimes?: number;
  /** Periods executed so far — the manual counts FAILED periods too. */
  alreadyTimes?: number;
  amount?: number;
  authCode?: string;
  escrowBank?: string;
  authBank?: string;
  /** Next scheduled auth date; the LAST period repeats its own date here. */
  nextAuthDate?: string;
  periodNo?: string;
  raw: { envelope: Record<string, string>; decrypted: Record<string, unknown> };
}

/** Verify + decrypt a mandate-creation result (ReturnURL / NotifyURL). */
export function verifyPeriodCreateNotify(
  input: NewebpayNotifyInput,
  credentials: NewebpayNotifyCredentials,
): NewebpayPeriodCreateNotify {
  const { envelope, decrypted, status, message, result, merchantId, merTradeNo } =
    decryptPeriodEnvelope(input, credentials);
  return {
    success: status === "SUCCESS",
    status,
    message,
    merchantId,
    merTradeNo,
    periodNo: str(result.PeriodNo),
    periodType: str(result.PeriodType),
    authTimes: num(result.AuthTimes),
    dateArray: str(result.DateArray)?.split(",") ?? [],
    periodAmt: num(result.PeriodAmt),
    auth: result.TradeNo
      ? {
          authTime: str(result.AuthTime),
          tradeNo: str(result.TradeNo),
          cardNo: str(result.CardNo),
          authCode: str(result.AuthCode),
          respondCode: str(result.RespondCode),
          escrowBank: str(result.EscrowBank),
          authBank: str(result.AuthBank),
          paymentMethod: str(result.PaymentMethod),
        }
      : undefined,
    raw: { envelope, decrypted },
  };
}

/** Verify + decrypt an each-period result [NPA-N050] from the mandate NotifyURL. */
export function verifyPeriodCycleNotify(
  input: NewebpayNotifyInput,
  credentials: NewebpayNotifyCredentials,
): NewebpayPeriodCycleNotify {
  const { envelope, decrypted, status, message, result, merchantId, merTradeNo } =
    decryptPeriodEnvelope(input, credentials);
  const orderNo = str(result.OrderNo);
  const sequence = orderNo ? /_(\d+)$/.exec(orderNo)?.[1] : undefined;
  return {
    success: status === "SUCCESS",
    status,
    message,
    merchantId,
    merTradeNo,
    orderNo,
    periodSequence: sequence !== undefined ? Number(sequence) : undefined,
    tradeNo: str(result.TradeNo),
    authDate: str(result.AuthDate),
    totalTimes: num(result.TotalTimes),
    alreadyTimes: num(result.AlreadyTimes),
    amount: num(result.AuthAmt),
    authCode: str(result.AuthCode),
    escrowBank: str(result.EscrowBank),
    authBank: str(result.AuthBank),
    nextAuthDate: str(result.NextAuthDate),
    periodNo: str(result.PeriodNo),
    raw: { envelope, decrypted },
  };
}

/**
 * Shared envelope handling: locate `Period`/`period`, decrypt, parse, and
 * check the merchant identity. Also used by the provider to decode
 * AlterStatus/AlterAmt HTTP responses (same envelope, server-to-server).
 */
export function decryptPeriodEnvelope(
  input: NewebpayNotifyInput,
  credentials: NewebpayNotifyCredentials,
): {
  envelope: Record<string, string>;
  decrypted: Record<string, unknown>;
  status: string;
  message: string;
  result: Record<string, unknown>;
  merchantId: string;
  merTradeNo: string;
} {
  const { hashKey, hashIv, merchantId: expectedMerchantId } = credentials;
  if (!hashKey || !hashIv) {
    throw new PaymentError("AUTH", "缺少 NewebPay 憑證（HashKey / HashIV）", "newebpay-period");
  }
  const envelope = coerceNewebpayNotifyBody(input);
  // The manual prints `Period` for create/N050/AlterAmt but `period` for
  // AlterStatus — accept both casings.
  const encrypted = envelope.Period ?? envelope.period;
  if (!encrypted) {
    throw new PaymentError("AUTH", "NewebPay 定期定額通知缺少 Period 欄位", "newebpay-period", {
      raw: envelope,
    });
  }
  let plain: string;
  try {
    plain = decryptTradeInfo(encrypted, hashKey, hashIv);
  } catch (err) {
    throw new PaymentError(
      "AUTH",
      "NewebPay 定期定額通知解密失敗（HashKey/HashIV 不符或內容毀損）",
      "newebpay-period",
      { raw: envelope, cause: err },
    );
  }
  const decrypted = parseDecryptedPayload(plain);
  const result = extractResult(decrypted);
  const status = str(decrypted.Status) ?? "";
  const message = str(decrypted.Message) ?? "";
  const merchantId = str(result.MerchantID) ?? "";
  // Create/N050 results carry MerchantOrderNo; alter results carry MerOrderNo.
  const merTradeNo = str(result.MerchantOrderNo) ?? str(result.MerOrderNo) ?? "";
  if (expectedMerchantId && merchantId && merchantId !== expectedMerchantId) {
    throw new PaymentError(
      "VALIDATION",
      `NewebPay 定期定額通知 MerchantID 不符（expected ${expectedMerchantId}, got ${merchantId}）`,
      "newebpay-period",
      { raw: { envelope, decrypted } },
    );
  }
  return { envelope, decrypted, status, message, result, merchantId, merTradeNo };
}

function str(input: unknown): string | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  return String(input);
}

function num(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const value = Number(input);
  return Number.isNaN(value) ? undefined : value;
}
