import { PaymentError } from "@paid-tw/payment";
import { asNumber, text } from "../scalars.js";
import { decryptData } from "./aes.js";

/**
 * Merchant response body for ECPG ReturnURL — same literal as AIO.
 * @see https://developers.ecpay.com.tw/?p=9058
 */
export const ECPG_NOTIFY_ACK = "1|OK" as const;

export interface EcpgNotifyCredentials {
  hashKey: string;
  hashIv: string;
  /** When set, rejects notifies whose outer or inner MerchantID does not match. */
  merchantId?: string;
  /**
   * Provider tag stamped onto thrown {@link PaymentError}s. Defaults to
   * `"ecpay-ecpg"`; 非信用卡幕後取號 passes `"ecpay-paycode"` since it shares this
   * envelope but is a different adapter.
   */
  providerName?: string;
}

/** Outer JSON POST body from ECPG ReturnURL (Content-Type: application/json). */
export interface EcpgNotifyEnvelope {
  MerchantID?: string;
  RpHeader?: { Timestamp?: number };
  TransCode?: number | string;
  TransMsg?: string;
  Data?: string;
}

/**
 * Verified, normalized 站內付 2.0 payment notify.
 *
 * Callers should ship only when `success && !simulated`, then respond with
 * {@link ECPG_NOTIFY_ACK}.
 */
export interface EcpgPaymentNotify {
  success: boolean;
  simulated: boolean;
  merchantId: string;
  merTradeNo: string;
  tradeNo?: string;
  amount?: number;
  method: string;
  paidAt?: string;
  tradeDate?: string;
  tradeStatus?: string;
  rtnCode: number;
  rtnMsg: string;
  /** Credit auth id (gwsr) when present. */
  creditRefundId?: string;
  card?: {
    authCode?: string;
    card6No?: string;
    card4No?: string;
    amount?: number;
  };
  /**
   * ATM payer identity (付款人銀行代碼 / 帳號後五碼). ECPay only fills these for
   * 第一銀行 007 / 中國信託 822 / 板信 118 / 國泰世華 013 — blank otherwise.
   */
  atm?: { bankCode?: string; accountNo?: string };
  /** `payStoreId` / `payStoreName` let merchants check the paying store before shipping. */
  cvs?: {
    paymentNo?: string;
    payFrom?: string;
    paymentUrl?: string;
    payStoreId?: string;
    payStoreName?: string;
  };
  /** 超商條碼 — the notify only carries `PayFrom`; the segments came back at 取號 time. */
  barcode?: { payFrom?: string };
  /** Decrypted business payload. */
  data: Record<string, unknown>;
  /** Outer envelope (TransCode / Data ciphertext, etc.). */
  envelope: EcpgNotifyEnvelope;
}

/**
 * Verify an ECPay AES-JSON ReturnURL notify: TransCode + AES-decrypt Data.
 *
 * Shared verifier for 站內付 2.0 and 非信用卡幕後取號 — identical envelope, ACK and
 * `OrderInfo`/`ATMInfo`/`CVSInfo`/`BarcodeInfo` shape. Pass
 * {@link EcpgNotifyCredentials.providerName} to attribute errors to the right adapter.
 *
 * @see https://developers.ecpay.com.tw/?p=9058 (站內付 2.0)
 * @see https://developers.ecpay.com.tw/28010 (幕後取號 付款結果通知)
 * @see SDK_PHP example/Payment/Ecpg/GetResponse.php
 */
export function verifyEcpgPaymentNotify(
  input: EcpgNotifyEnvelope | string | Record<string, unknown>,
  credentials: EcpgNotifyCredentials,
): EcpgPaymentNotify {
  const { hashKey, hashIv, merchantId: expectedMerchantId } = credentials;
  const provider = credentials.providerName ?? "ecpay-ecpg";
  if (!hashKey || !hashIv) {
    throw new PaymentError("AUTH", "缺少 ECPay AES-JSON 憑證（HashKey / HashIV）", provider);
  }

  const envelope = coerceEnvelope(input, provider);

  const transCode = Number(envelope.TransCode);
  if (transCode !== 1) {
    throw new PaymentError(
      "PROVIDER",
      `ECPay 通知 TransCode=${envelope.TransCode}: ${envelope.TransMsg ?? ""}`,
      provider,
      {
        rawCode: envelope.TransCode !== undefined ? String(envelope.TransCode) : undefined,
        rawMessage: envelope.TransMsg,
        raw: envelope,
      },
    );
  }

  if (!envelope.Data) {
    throw new PaymentError("VALIDATION", "ECPay 通知缺少 Data", provider, {
      raw: envelope,
    });
  }

  let data: Record<string, unknown>;
  try {
    data = decryptData<Record<string, unknown>>(envelope.Data, hashKey, hashIv);
  } catch (err) {
    throw new PaymentError("AUTH", "ECPay 通知 Data 解密失敗", provider, {
      cause: err,
      raw: envelope,
    });
  }

  // A null inner MerchantID must fall through to the envelope, not become "null"
  // and then fail the comparison below.
  const merchantId = text(data.MerchantID) ?? envelope.MerchantID ?? "";
  if (expectedMerchantId && merchantId && merchantId !== expectedMerchantId) {
    throw new PaymentError(
      "VALIDATION",
      `ECPay 通知 MerchantID 不符（expected ${expectedMerchantId}, got ${merchantId}）`,
      provider,
      { raw: { envelope, data } },
    );
  }
  if (expectedMerchantId && envelope.MerchantID && envelope.MerchantID !== expectedMerchantId) {
    throw new PaymentError(
      "VALIDATION",
      `ECPay 通知外層 MerchantID 不符（expected ${expectedMerchantId}, got ${envelope.MerchantID}）`,
      provider,
      { raw: envelope },
    );
  }

  const orderInfo = (data.OrderInfo ?? {}) as Record<string, unknown>;
  const cardInfo = (data.CardInfo ?? {}) as Record<string, unknown>;
  const atmInfo = (data.ATMInfo ?? {}) as Record<string, unknown>;
  const cvsInfo = (data.CVSInfo ?? {}) as Record<string, unknown>;
  const barcodeInfo = (data.BarcodeInfo ?? {}) as Record<string, unknown>;

  const rtnCode = Number(data.RtnCode);
  const success = rtnCode === 1;
  const simulated = data.SimulatePaid === 1 || data.SimulatePaid === "1";

  const merTradeNo = text(orderInfo.MerchantTradeNo) ?? "";
  if (!merTradeNo) {
    // Some early/token-only samples omit OrderInfo; still return structured result.
  }

  const paymentType = text(orderInfo.PaymentType) ?? text(data.PaymentType);

  // Every optional string goes through `text()`: ECPay mixes "" and null for
  // "no value", and String(null) would surface as the literal "null".
  const card = {
    authCode: text(cardInfo.AuthCode),
    card6No: text(cardInfo.Card6No),
    card4No: text(cardInfo.Card4No),
    amount: asNumber(cardInfo.Amount),
  };
  const atm = {
    bankCode: text(atmInfo.ATMAccBank),
    accountNo: text(atmInfo.ATMAccNo),
  };
  const cvs = {
    paymentNo: text(cvsInfo.PaymentNo),
    payFrom: text(cvsInfo.PayFrom),
    paymentUrl: text(cvsInfo.PaymentURL),
    payStoreId: text(cvsInfo.PayStoreID),
    payStoreName: text(cvsInfo.PayStoreName),
  };
  const barcodePayFrom = text(barcodeInfo.PayFrom);

  return {
    success,
    simulated,
    merchantId: merchantId || expectedMerchantId || "",
    merTradeNo,
    tradeNo: text(orderInfo.TradeNo),
    amount: asNumber(orderInfo.TradeAmt) ?? asNumber(cardInfo.Amount),
    method: mapPaymentType(paymentType),
    paidAt: text(orderInfo.PaymentDate),
    tradeDate: text(orderInfo.TradeDate),
    tradeStatus: text(orderInfo.TradeStatus),
    rtnCode: Number.isFinite(rtnCode) ? rtnCode : -1,
    rtnMsg: text(data.RtnMsg) ?? "",
    creditRefundId: text(cardInfo.Gwsr) ?? text(data.Gwsr),
    card: (card.authCode ?? card.card6No ?? card.card4No) ? card : undefined,
    atm: (atm.bankCode ?? atm.accountNo) ? atm : undefined,
    cvs: (cvs.paymentNo ?? cvs.payFrom) ? cvs : undefined,
    barcode: barcodePayFrom ? { payFrom: barcodePayFrom } : undefined,
    data,
    envelope,
  };
}

function coerceEnvelope(
  input: EcpgNotifyEnvelope | string | Record<string, unknown>,
  provider: string,
): EcpgNotifyEnvelope {
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as EcpgNotifyEnvelope;
    } catch (err) {
      throw new PaymentError("VALIDATION", "ECPay 通知 body 不是合法 JSON", provider, {
        cause: err,
        raw: input,
      });
    }
  }
  return input as EcpgNotifyEnvelope;
}

function mapPaymentType(value?: string): string {
  if (!value) return "unknown";
  const v = value.toLowerCase();
  if (v === "credit" || v.startsWith("credit")) return "card";
  if (v === "atm" || v.startsWith("atm")) return "atm";
  if (v === "cvs") return "cvs";
  if (v === "barcode") return "barcode";
  if (v === "applepay") return "applepay";
  if (v === "unionpay") return "unionpay";
  return value;
}
