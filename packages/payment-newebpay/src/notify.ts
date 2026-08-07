import { PaymentError } from "@paid-tw/payment";
import { decryptTradeInfo, tradeSha } from "./crypto.js";

/**
 * NewebPay notify verification (NDNF-1.2.3 §4.2.2 / §4.2.3).
 *
 * The same envelope shape arrives at three URLs:
 * - **NotifyURL** — background server POST of the payment result. NewebPay
 *   counts delivery only on an **HTTP 200** response (any body); 3 failed
 *   retries and the notify is dropped. There is no ACK body string.
 * - **ReturnURL** — the same payment-result fields as a front-channel form
 *   POST redirect.
 * - **CustomerURL** — the 取號 (get-code) result for ATM/CVS/barcode/CVSCOM,
 *   which fires when the code is issued, NOT when it is paid — verify it with
 *   {@link verifyNewebpayGetCodeNotify}, and wait for the NotifyURL notify
 *   (sent after the consumer pays and the bank clears) before shipping.
 *
 * Verification order matters: TradeSha is recomputed over the ciphertext and
 * compared BEFORE decrypting — a forged body never reaches the parser.
 */

/** Raw form fields of the notify envelope (all values as strings). */
export type NewebpayNotifyBody = Record<string, string>;

/** Loose input: parsed body object, URLSearchParams, or the raw body string. */
export type NewebpayNotifyInput =
  | NewebpayNotifyBody
  | URLSearchParams
  | string
  | Record<string, string | string[] | undefined | null>;

export interface NewebpayNotifyCredentials {
  hashKey: string;
  hashIv: string;
  /** When set, rejects notifies whose MerchantID does not match. */
  merchantId?: string;
}

/** Verified, normalized payment-result notification (NotifyURL / ReturnURL). */
export interface NewebpayPaymentNotify {
  /** Decrypted `Status === "SUCCESS"`. */
  success: boolean;
  /** The decrypted Status verbatim — an error code (e.g. MPG03009) on failure. */
  status: string;
  message: string;
  merchantId: string;
  merTradeNo: string;
  tradeNo?: string;
  amount?: number;
  /** Normalized family: card / atm / cvs / barcode / linepay / … */
  method: string;
  /** Raw PaymentType (CREDIT / VACC / CVS / …). */
  paymentType?: string;
  paidAt?: string;
  ip?: string;
  escrowBank?: string;
  /** Credit-card family extras (present when PaymentType is CREDIT). */
  card?: {
    card6No?: string;
    card4No?: string;
    authCode?: string;
    authBank?: string;
    respondCode?: string;
    eci?: string;
    paymentMethod?: string;
  };
  /** WebATM / ATM transfer extras. */
  atm?: { payBankCode?: string; payerAccount5Code?: string };
  /** CVS code (paid) extras. */
  cvs?: { codeNo?: string; storeType?: string; storeId?: string };
  /** CVS barcode (paid) extras. */
  barcode?: { barcode1?: string; barcode2?: string; barcode3?: string; payStore?: string };
  /** Envelope + full decrypted payload, for anything not normalized above. */
  raw: { envelope: NewebpayNotifyBody; decrypted: Record<string, unknown> };
}

/** Verified 取號 (get-code) notification from CustomerURL. */
export interface NewebpayGetCodeNotify {
  /** Decrypted `Status === "SUCCESS"` — the consumer now has a code to pay with. */
  success: boolean;
  status: string;
  message: string;
  merchantId: string;
  merTradeNo: string;
  tradeNo?: string;
  amount?: number;
  /** Normalized family: atm / cvs / barcode / cvscom. */
  method: string;
  paymentType?: string;
  /** Code expiry, `yyyy-mm-dd` (absent for CVSCOM 取貨付款). */
  expireDate?: string;
  /** Code expiry time, `His` (e.g. 235959). */
  expireTime?: string;
  /** ATM 虛擬帳號. */
  atm?: { bankCode?: string; codeNo?: string };
  /** 超商代碼. */
  cvs?: { codeNo?: string };
  /** 超商條碼 — three Code39 segments. */
  barcode?: { barcode1?: string; barcode2?: string; barcode3?: string };
  raw: { envelope: NewebpayNotifyBody; decrypted: Record<string, unknown> };
}

/**
 * Verify a payment-result POST (NotifyURL server notify or ReturnURL browser
 * POST): TradeSha over the ciphertext, AES decrypt, then identity checks.
 *
 * @throws {PaymentError} `AUTH` when TradeSha is missing/mismatched or the
 *   payload does not decrypt under these credentials; `VALIDATION` when
 *   required fields are absent or MerchantID mismatches; `UNSUPPORTED` for
 *   EncryptType=1 (AES-GCM — no published spec to implement against).
 */
export function verifyNewebpayPaymentNotify(
  input: NewebpayNotifyInput,
  credentials: NewebpayNotifyCredentials,
): NewebpayPaymentNotify {
  const { envelope, decrypted, status, message, result, merchantId, merTradeNo } =
    assertNotifyAuthentic(input, credentials);

  const paymentType = str(result.PaymentType);
  const family = mapNewebpayPaymentType(paymentType);
  return {
    success: status === "SUCCESS",
    status,
    message,
    merchantId,
    merTradeNo,
    tradeNo: str(result.TradeNo),
    amount: num(result.Amt),
    method: family,
    paymentType,
    paidAt: dateTime(result.PayTime),
    ip: str(result.IP),
    escrowBank: str(result.EscrowBank),
    card:
      family === "card"
        ? {
            card6No: str(result.Card6No),
            card4No: str(result.Card4No),
            authCode: str(result.Auth),
            authBank: str(result.AuthBank),
            respondCode: str(result.RespondCode),
            eci: str(result.ECI),
            paymentMethod: str(result.PaymentMethod),
          }
        : undefined,
    atm:
      family === "atm" || family === "webatm"
        ? {
            payBankCode: str(result.PayBankCode),
            payerAccount5Code: str(result.PayerAccount5Code),
          }
        : undefined,
    cvs:
      family === "cvs"
        ? {
            codeNo: str(result.CodeNo),
            storeType: str(result.StoreType),
            storeId: str(result.StoreID),
          }
        : undefined,
    barcode:
      family === "barcode"
        ? {
            barcode1: str(result.Barcode_1),
            barcode2: str(result.Barcode_2),
            barcode3: str(result.Barcode_3),
            payStore: str(result.PayStore),
          }
        : undefined,
    raw: { envelope, decrypted },
  };
}

/**
 * Verify a 取號結果 (get-code) POST from CustomerURL. Same envelope and
 * authentication as the payment notify, but it means "the consumer received a
 * payment code", not "paid" — the paid notify still arrives at NotifyURL after
 * bank clearing.
 */
export function verifyNewebpayGetCodeNotify(
  input: NewebpayNotifyInput,
  credentials: NewebpayNotifyCredentials,
): NewebpayGetCodeNotify {
  const { envelope, decrypted, status, message, result, merchantId, merTradeNo } =
    assertNotifyAuthentic(input, credentials);

  const paymentType = str(result.PaymentType);
  const family = mapNewebpayPaymentType(paymentType);
  return {
    success: status === "SUCCESS",
    status,
    message,
    merchantId,
    merTradeNo,
    tradeNo: str(result.TradeNo),
    amount: num(result.Amt),
    method: family,
    paymentType,
    expireDate: str(result.ExpireDate),
    expireTime: str(result.ExpireTime),
    atm:
      family === "atm" ? { bankCode: str(result.BankCode), codeNo: str(result.CodeNo) } : undefined,
    cvs: family === "cvs" ? { codeNo: str(result.CodeNo) } : undefined,
    barcode:
      family === "barcode"
        ? {
            barcode1: str(result.Barcode_1),
            barcode2: str(result.Barcode_2),
            barcode3: str(result.Barcode_3),
          }
        : undefined,
    raw: { envelope, decrypted },
  };
}

/**
 * Shared authenticity check: TradeSha over the ciphertext BEFORE decrypting,
 * then the identity fields. One owner on purpose — the payment notify and the
 * get-code notify differ in meaning, not authentication.
 */
function assertNotifyAuthentic(
  input: NewebpayNotifyInput,
  credentials: NewebpayNotifyCredentials,
): {
  envelope: NewebpayNotifyBody;
  decrypted: Record<string, unknown>;
  status: string;
  message: string;
  result: Record<string, unknown>;
  merchantId: string;
  merTradeNo: string;
} {
  const { hashKey, hashIv, merchantId: expectedMerchantId } = credentials;
  if (!hashKey || !hashIv) {
    throw new PaymentError("AUTH", "缺少 NewebPay 憑證（HashKey / HashIV）", "newebpay");
  }

  const envelope = coerceNewebpayNotifyBody(input);
  if (envelope.EncryptType === "1") {
    throw new PaymentError(
      "UNSUPPORTED",
      "NewebPay EncryptType=1（AES-GCM）通知尚未支援，請以 AES-CBC（EncryptType=0）建立交易",
      "newebpay",
      { raw: envelope },
    );
  }
  const tradeInfo = envelope.TradeInfo;
  const returnedSha = envelope.TradeSha;
  if (!tradeInfo || !returnedSha) {
    throw new PaymentError("AUTH", "NewebPay 通知缺少 TradeInfo 或 TradeSha", "newebpay", {
      raw: envelope,
    });
  }
  if (tradeSha(tradeInfo, hashKey, hashIv) !== returnedSha.toUpperCase()) {
    throw new PaymentError("AUTH", "NewebPay 通知 TradeSha 驗證失敗", "newebpay", {
      raw: envelope,
    });
  }

  let plain: string;
  try {
    plain = decryptTradeInfo(tradeInfo, hashKey, hashIv);
  } catch (err) {
    throw new PaymentError("AUTH", "NewebPay 通知 TradeInfo 解密失敗", "newebpay", {
      raw: envelope,
      cause: err,
    });
  }
  const decrypted = parseDecryptedPayload(plain);
  const status = str(decrypted.Status) ?? "";
  const message = str(decrypted.Message) ?? "";
  const result = extractResult(decrypted);

  const merchantId = str(result.MerchantID) ?? envelope.MerchantID ?? "";
  const merTradeNo = str(result.MerchantOrderNo) ?? "";
  if (!merchantId || !merTradeNo) {
    throw new PaymentError(
      "VALIDATION",
      "NewebPay 通知缺少 MerchantID 或 MerchantOrderNo",
      "newebpay",
      { raw: { envelope, decrypted } },
    );
  }
  if (expectedMerchantId && merchantId !== expectedMerchantId) {
    throw new PaymentError(
      "VALIDATION",
      `NewebPay 通知 MerchantID 不符（expected ${expectedMerchantId}, got ${merchantId}）`,
      "newebpay",
      { raw: { envelope, decrypted } },
    );
  }
  return { envelope, decrypted, status, message, result, merchantId, merTradeNo };
}

/**
 * The decrypted TradeInfo is JSON (`RespondType=JSON`) or a query string
 * (`RespondType=String`, fields flat at the top level).
 */
function parseDecryptedPayload(plain: string): Record<string, unknown> {
  const trimmed = plain.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // fall through to query-string parsing
    }
  }
  return Object.fromEntries(new URLSearchParams(trimmed).entries());
}

/** JSON payloads nest fields under `Result`; String payloads are flat. */
function extractResult(decrypted: Record<string, unknown>): Record<string, unknown> {
  const result = decrypted.Result;
  if (Array.isArray(result)) return (result[0] ?? {}) as Record<string, unknown>;
  if (result && typeof result === "object") return result as Record<string, unknown>;
  return decrypted;
}

/** Coerce framework-agnostic body shapes into a flat string map. */
export function coerceNewebpayNotifyBody(input: NewebpayNotifyInput): NewebpayNotifyBody {
  if (typeof input === "string") {
    return Object.fromEntries(new URLSearchParams(input).entries());
  }
  if (input instanceof URLSearchParams) {
    return Object.fromEntries(input.entries());
  }
  const out: NewebpayNotifyBody = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? String(value[0] ?? "") : String(value);
  }
  return out;
}

/** NewebPay PaymentType → normalized family (shared by query + notify paths). */
export function mapNewebpayPaymentType(value?: string): string {
  switch (value) {
    case "CREDIT":
      return "card";
    case "VACC":
      return "atm";
    case "WEBATM":
      return "webatm";
    case "CVS":
      return "cvs";
    case "BARCODE":
      return "barcode";
    case "LINEPAY":
      return "linepay";
    case "CVSCOM":
      return "cvscom";
    case "ESUNWALLET":
      return "esunwallet";
    case "TAIWANPAY":
      return "taiwanpay";
    case "TWQR":
      return "twqr";
    case "AFTEE":
      return "aftee";
    case "BITOPAY":
      return "bitopay";
    case "EZPALIPAY":
      return "alipay";
    case "EZPWECHAT":
      return "wechatpay";
    default:
      return value ? value.toLowerCase() : "unknown";
  }
}

function str(input: unknown): string | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  return String(input);
}

function dateTime(input: unknown): string | undefined {
  const value = str(input);
  if (!value || value.startsWith("0000-00-00")) return undefined;
  return value;
}

function num(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const value = Number(input);
  return Number.isNaN(value) ? undefined : value;
}
