import { PaymentError } from "@paid-tw/payment";
import { decryptData, encryptData } from "./aes.js";

export interface EcpgEnvelopeResponse {
  MerchantID?: string;
  RpHeader?: { Timestamp?: number };
  TransCode?: number;
  TransMsg?: string;
  Data?: string;
}

/**
 * POST JSON envelope to an ECPay AES-JSON endpoint: encrypt `data` as `Data`,
 * verify the outer TransCode, decrypt the business payload. Mirrors PHP
 * `PostWithAesJsonResponseService`.
 *
 * Shared by 站內付 2.0 (`ecpg.ecpay.com.tw`) and 非信用卡幕後取號
 * (`ecpayment.ecpay.com.tw`) — both use the same three-layer envelope and the
 * same `RqHeader: { Timestamp }` (no `Revision`, unlike the invoice/logistics
 * AES-JSON services). Callers still have to check the inner `RtnCode`
 * themselves: TransCode only reports transport/crypto success.
 */
export async function ecpgPost<T extends Record<string, unknown>>(options: {
  url: string;
  merchantId: string;
  hashKey: string;
  hashIv: string;
  data: Record<string, unknown>;
  label: string;
  /** Provider tag + message prefix for errors. Defaults to the ECPG adapter. */
  provider?: string;
  messagePrefix?: string;
}): Promise<T> {
  const { url, merchantId, hashKey, hashIv, data, label } = options;
  const provider = options.provider ?? "ecpay-ecpg";
  const prefix = options.messagePrefix ?? "ECPay ECPG";
  const body = {
    MerchantID: merchantId,
    RqHeader: { Timestamp: Math.floor(Date.now() / 1000) },
    Data: encryptData(data, hashKey, hashIv),
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new PaymentError("NETWORK", `${prefix} ${label} 連線失敗`, provider, {
      cause: err,
    });
  }

  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER",
      `${prefix} ${label} failed: ${response.status} ${response.statusText}`,
      provider,
      { rawCode: String(response.status) },
    );
  }

  const envelope = (await response.json()) as EcpgEnvelopeResponse;
  if (process.env.PAID_DEBUG === "1") {
    console.error(`[${provider}] ${label} TransCode:`, envelope.TransCode, envelope.TransMsg);
  }

  if (envelope.TransCode !== 1) {
    throw new PaymentError(
      "PROVIDER",
      `${prefix} ${label} TransCode=${envelope.TransCode}: ${envelope.TransMsg ?? ""}`,
      provider,
      {
        rawCode: envelope.TransCode !== undefined ? String(envelope.TransCode) : undefined,
        rawMessage: envelope.TransMsg,
        raw: envelope,
      },
    );
  }

  if (!envelope.Data) {
    throw new PaymentError("PROVIDER", `${prefix} ${label} 回應缺少 Data`, provider, {
      raw: envelope,
    });
  }

  let decoded: T;
  try {
    decoded = decryptData<T>(envelope.Data, hashKey, hashIv);
  } catch (err) {
    throw new PaymentError("PROVIDER", `${prefix} ${label} Data 解密失敗`, provider, {
      cause: err,
      raw: envelope,
    });
  }

  if (process.env.PAID_DEBUG === "1") {
    console.error(`[${provider}] ${label} Data:`, JSON.stringify(decoded));
  }

  return decoded;
}
