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
 * POST JSON envelope to ECPG: encrypt `data` as `Data`, verify TransCode, decrypt
 * business payload. Mirrors PHP `PostWithAesJsonResponseService`.
 */
export async function ecpgPost<T extends Record<string, unknown>>(options: {
  url: string;
  merchantId: string;
  hashKey: string;
  hashIv: string;
  data: Record<string, unknown>;
  label: string;
}): Promise<T> {
  const { url, merchantId, hashKey, hashIv, data, label } = options;
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
    throw new PaymentError("NETWORK", `ECPay ECPG ${label} 連線失敗`, "ecpay-ecpg", {
      cause: err,
    });
  }

  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER",
      `ECPay ECPG ${label} failed: ${response.status} ${response.statusText}`,
      "ecpay-ecpg",
      { rawCode: String(response.status) },
    );
  }

  const envelope = (await response.json()) as EcpgEnvelopeResponse;
  if (process.env.PAID_DEBUG === "1") {
    console.error(`[ecpay-ecpg] ${label} TransCode:`, envelope.TransCode, envelope.TransMsg);
  }

  if (envelope.TransCode !== 1) {
    throw new PaymentError(
      "PROVIDER",
      `ECPay ECPG ${label} TransCode=${envelope.TransCode}: ${envelope.TransMsg ?? ""}`,
      "ecpay-ecpg",
      {
        rawCode: envelope.TransCode !== undefined ? String(envelope.TransCode) : undefined,
        rawMessage: envelope.TransMsg,
        raw: envelope,
      },
    );
  }

  if (!envelope.Data) {
    throw new PaymentError("PROVIDER", `ECPay ECPG ${label} 回應缺少 Data`, "ecpay-ecpg", {
      raw: envelope,
    });
  }

  let decoded: T;
  try {
    decoded = decryptData<T>(envelope.Data, hashKey, hashIv);
  } catch (err) {
    throw new PaymentError("PROVIDER", `ECPay ECPG ${label} Data 解密失敗`, "ecpay-ecpg", {
      cause: err,
      raw: envelope,
    });
  }

  if (process.env.PAID_DEBUG === "1") {
    console.error(`[ecpay-ecpg] ${label} Data:`, JSON.stringify(decoded));
  }

  return decoded;
}
