import { PaymentError } from "@paid-tw/payment";
import { str } from "../scalars.js";
import { decryptData, encryptData } from "./aes.js";

export interface EcpgEnvelopeResponse {
  MerchantID?: string;
  RpHeader?: { Timestamp?: number };
  TransCode?: number;
  TransMsg?: string;
  Data?: string;
}

/** Options every AES-JSON call shares. */
interface EcpgRequestOptions {
  url: string;
  merchantId: string;
  hashKey: string;
  hashIv: string;
  data: Record<string, unknown>;
  label: string;
  /** Provider tag + message prefix for errors. Defaults to the ECPG adapter. */
  provider?: string;
  messagePrefix?: string;
}

/** Error attribution, defaulted once so both entry points agree. */
function resolveTags(options: EcpgRequestOptions): { provider: string; prefix: string } {
  return {
    provider: options.provider ?? "ecpay-ecpg",
    prefix: options.messagePrefix ?? "ECPay ECPG",
  };
}

/** The outer three-field envelope: `MerchantID` + `RqHeader.Timestamp` + AES `Data`. */
function buildEcpgBody(options: EcpgRequestOptions): Record<string, unknown> {
  return {
    MerchantID: options.merchantId,
    RqHeader: { Timestamp: Math.floor(Date.now() / 1000) },
    Data: encryptData(options.data, options.hashKey, options.hashIv),
  };
}

/**
 * POST the envelope and hand back the raw {@link Response}, with transport and
 * HTTP-status failures already normalized.
 *
 * Sole owner of the request side for every AES-JSON call, so a future change to
 * headers, timeouts or retries lands in one place — response *decoding* is what
 * differs between callers, not the request.
 */
async function doEcpgFetch(options: EcpgRequestOptions): Promise<Response> {
  const { provider, prefix } = resolveTags(options);
  const { url, label } = options;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildEcpgBody(options)),
    });
  } catch (err) {
    throw new PaymentError("NETWORK", `${prefix} ${label} 連線失敗`, provider, { cause: err });
  }

  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER",
      `${prefix} ${label} failed: ${response.status} ${response.statusText}`,
      provider,
      { rawCode: String(response.status) },
    );
  }
  return response;
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
export async function ecpgPost<T extends Record<string, unknown>>(
  options: EcpgRequestOptions,
): Promise<T> {
  const { hashKey, hashIv, label } = options;
  const { provider, prefix } = resolveTags(options);

  const response = await doEcpgFetch(options);
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

/**
 * POST the same AES-JSON envelope but return the response **body as text**.
 *
 * `QueryTradeMedia` (撥款對帳檔) is the odd one out in this API family: on success it
 * answers a CSV file rather than the three-layer envelope, so {@link ecpgPost}
 * would reject it for having no `Data`. Failures, however, still come back as a
 * normal envelope — so this detects that case and raises it the same way
 * {@link ecpgPost} would, rather than handing the caller an error JSON masquerading
 * as a report.
 *
 * @see https://developers.ecpay.com.tw/41186
 */
export async function ecpgPostForText(
  options: EcpgRequestOptions,
): Promise<{ text: string; contentType: string | null }> {
  const { hashKey, hashIv, label } = options;
  const { provider, prefix } = resolveTags(options);

  const response = await doEcpgFetch(options);
  const text = await response.text();
  if (process.env.PAID_DEBUG === "1") {
    console.error(`[${provider}] ${label} ${text.length}B:`, text.slice(0, 500));
  }

  assertNotErrorEnvelope({ text, hashKey, hashIv, label, provider, prefix });
  return { text, contentType: response.headers.get("content-type") };
}

/**
 * A text response that parses as an AES-JSON envelope is an error report, not a
 * file — surface it instead of returning it as report content.
 */
function assertNotErrorEnvelope(options: {
  text: string;
  hashKey: string;
  hashIv: string;
  label: string;
  provider: string;
  prefix: string;
}): void {
  const { text, hashKey, hashIv, label, provider, prefix } = options;
  if (!text.trimStart().startsWith("{")) return;

  let envelope: EcpgEnvelopeResponse;
  try {
    envelope = JSON.parse(text) as EcpgEnvelopeResponse;
  } catch {
    // Starts with "{" but is not JSON — treat as file content and let the caller
    // decide; better than throwing away a report over a heuristic.
    return;
  }
  if (envelope.TransCode === undefined && envelope.Data === undefined) return;

  let detail = envelope.TransMsg ?? "";
  if (envelope.Data) {
    try {
      const decoded = decryptData<{ RtnCode?: unknown; RtnMsg?: unknown }>(
        envelope.Data,
        hashKey,
        hashIv,
      );
      detail = `RtnCode=${str(decoded.RtnCode) || "?"}: ${str(decoded.RtnMsg) || detail}`;
    } catch {
      // Keep TransMsg as the detail.
    }
  }
  throw new PaymentError("PROVIDER", `${prefix} ${label} 失敗（${detail}）`, provider, {
    rawCode: envelope.TransCode !== undefined ? String(envelope.TransCode) : undefined,
    rawMessage: envelope.TransMsg,
    raw: envelope,
  });
}
