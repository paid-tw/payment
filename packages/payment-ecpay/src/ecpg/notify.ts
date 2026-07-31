import { PaymentError } from "@paid-tw/payment";
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
  atm?: { bankCode?: string; accountNo?: string };
  cvs?: { paymentNo?: string; payFrom?: string };
  /** Decrypted business payload. */
  data: Record<string, unknown>;
  /** Outer envelope (TransCode / Data ciphertext, etc.). */
  envelope: EcpgNotifyEnvelope;
}

/**
 * Verify an ECPG ReturnURL JSON notify: TransCode + AES-decrypt Data.
 *
 * @see https://developers.ecpay.com.tw/?p=9058
 * @see SDK_PHP example/Payment/Ecpg/GetResponse.php
 */
export function verifyEcpgPaymentNotify(
  input: EcpgNotifyEnvelope | string | Record<string, unknown>,
  credentials: EcpgNotifyCredentials,
): EcpgPaymentNotify {
  const { hashKey, hashIv, merchantId: expectedMerchantId } = credentials;
  if (!hashKey || !hashIv) {
    throw new PaymentError("AUTH", "缺少 ECPay ECPG 憑證（HashKey / HashIV）", "ecpay-ecpg");
  }

  const envelope = coerceEnvelope(input);

  const transCode = Number(envelope.TransCode);
  if (transCode !== 1) {
    throw new PaymentError(
      "PROVIDER",
      `ECPay ECPG 通知 TransCode=${envelope.TransCode}: ${envelope.TransMsg ?? ""}`,
      "ecpay-ecpg",
      {
        rawCode: envelope.TransCode !== undefined ? String(envelope.TransCode) : undefined,
        rawMessage: envelope.TransMsg,
        raw: envelope,
      },
    );
  }

  if (!envelope.Data) {
    throw new PaymentError("VALIDATION", "ECPay ECPG 通知缺少 Data", "ecpay-ecpg", {
      raw: envelope,
    });
  }

  let data: Record<string, unknown>;
  try {
    data = decryptData<Record<string, unknown>>(envelope.Data, hashKey, hashIv);
  } catch (err) {
    throw new PaymentError("AUTH", "ECPay ECPG 通知 Data 解密失敗", "ecpay-ecpg", {
      cause: err,
      raw: envelope,
    });
  }

  const merchantId =
    (data.MerchantID !== undefined ? String(data.MerchantID) : undefined) ||
    envelope.MerchantID ||
    "";
  if (expectedMerchantId && merchantId && merchantId !== expectedMerchantId) {
    throw new PaymentError(
      "VALIDATION",
      `ECPay ECPG 通知 MerchantID 不符（expected ${expectedMerchantId}, got ${merchantId}）`,
      "ecpay-ecpg",
      { raw: { envelope, data } },
    );
  }
  if (expectedMerchantId && envelope.MerchantID && envelope.MerchantID !== expectedMerchantId) {
    throw new PaymentError(
      "VALIDATION",
      `ECPay ECPG 通知外層 MerchantID 不符（expected ${expectedMerchantId}, got ${envelope.MerchantID}）`,
      "ecpay-ecpg",
      { raw: envelope },
    );
  }

  const orderInfo = (data.OrderInfo ?? {}) as Record<string, unknown>;
  const cardInfo = (data.CardInfo ?? {}) as Record<string, unknown>;
  const atmInfo = (data.ATMInfo ?? {}) as Record<string, unknown>;
  const cvsInfo = (data.CVSInfo ?? {}) as Record<string, unknown>;

  const rtnCode = Number(data.RtnCode);
  const success = rtnCode === 1;
  const simulated = data.SimulatePaid === 1 || data.SimulatePaid === "1";

  const merTradeNo =
    orderInfo.MerchantTradeNo !== undefined ? String(orderInfo.MerchantTradeNo) : "";
  if (!merTradeNo) {
    // Some early/token-only samples omit OrderInfo; still return structured result.
  }

  const paymentType =
    orderInfo.PaymentType !== undefined
      ? String(orderInfo.PaymentType)
      : data.PaymentType !== undefined
        ? String(data.PaymentType)
        : undefined;

  return {
    success,
    simulated,
    merchantId: merchantId || expectedMerchantId || "",
    merTradeNo,
    tradeNo: orderInfo.TradeNo !== undefined ? String(orderInfo.TradeNo) : undefined,
    amount: asNumber(orderInfo.TradeAmt) ?? asNumber(cardInfo.Amount),
    method: mapPaymentType(paymentType),
    paidAt: orderInfo.PaymentDate !== undefined ? String(orderInfo.PaymentDate) : undefined,
    tradeDate: orderInfo.TradeDate !== undefined ? String(orderInfo.TradeDate) : undefined,
    tradeStatus: orderInfo.TradeStatus !== undefined ? String(orderInfo.TradeStatus) : undefined,
    rtnCode: Number.isFinite(rtnCode) ? rtnCode : -1,
    rtnMsg: data.RtnMsg !== undefined ? String(data.RtnMsg) : "",
    creditRefundId:
      cardInfo.Gwsr !== undefined
        ? String(cardInfo.Gwsr)
        : data.Gwsr !== undefined
          ? String(data.Gwsr)
          : undefined,
    card:
      cardInfo.AuthCode || cardInfo.Card6No || cardInfo.Card4No
        ? {
            authCode: cardInfo.AuthCode !== undefined ? String(cardInfo.AuthCode) : undefined,
            card6No: cardInfo.Card6No !== undefined ? String(cardInfo.Card6No) : undefined,
            card4No: cardInfo.Card4No !== undefined ? String(cardInfo.Card4No) : undefined,
            amount: asNumber(cardInfo.Amount),
          }
        : undefined,
    atm:
      atmInfo.ATMAccBank || atmInfo.ATMAccNo
        ? {
            bankCode: atmInfo.ATMAccBank !== undefined ? String(atmInfo.ATMAccBank) : undefined,
            accountNo: atmInfo.ATMAccNo !== undefined ? String(atmInfo.ATMAccNo) : undefined,
          }
        : undefined,
    cvs: cvsInfo.PaymentNo
      ? {
          paymentNo: String(cvsInfo.PaymentNo),
          payFrom: cvsInfo.PayFrom !== undefined ? String(cvsInfo.PayFrom) : undefined,
        }
      : undefined,
    data,
    envelope,
  };
}

function coerceEnvelope(
  input: EcpgNotifyEnvelope | string | Record<string, unknown>,
): EcpgNotifyEnvelope {
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as EcpgNotifyEnvelope;
    } catch (err) {
      throw new PaymentError("VALIDATION", "ECPay ECPG 通知 body 不是合法 JSON", "ecpay-ecpg", {
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

function asNumber(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const num = Number(input);
  return Number.isNaN(num) ? undefined : num;
}
