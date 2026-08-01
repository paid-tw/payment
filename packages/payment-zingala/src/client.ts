/**
 * HTTP transport for 中租零卡分期: headers, `Digest` verification, error normalization.
 *
 * Two-layer checking, like the ECPG adapters: the transport proves the response came from
 * 中租 (`Digest`), then the payload's own `result` decides success.
 */
import { PaymentError } from "@paid-tw/payment";
import { describeResult, ZINGALA_SUCCESS } from "./codes.js";
import { resolveZingalaOrigin, type ZingalaConfig } from "./config.js";
import { verifyDigest } from "./crypto.js";

const PROVIDER = "zingala";
const MESSAGE_PREFIX = "中租零卡分期";

/** Raw envelope every JSON endpoint shares. */
export interface ZingalaEnvelope {
  result: string;
  result_message?: string;
  [key: string]: unknown;
}

export interface ZingalaRequestOptions {
  /**
   * Accept a response with no `Digest` header.
   *
   * Off by default, and it should stay off: every recorded UAT response carried one, and
   * for BNPL the notify/response is what authorizes shipping goods. Exists only so a
   * caller stuck behind a proxy that strips headers can proceed knowingly.
   */
  allowUnsignedResponse?: boolean;
  /** Abort the request after this many ms. Default 30s. */
  timeoutMs?: number;
}

function requireCredentials(config: ZingalaConfig): void {
  for (const field of ["merchantId", "apiKey", "aesKey", "aesIv"] as const) {
    if (!config[field]) {
      throw new PaymentError(
        "AUTH",
        `${MESSAGE_PREFIX} 缺少憑證 ${field}（0Card-Merchant-Id / 0Card-API-Key / AES 金鑰）`,
        PROVIDER,
      );
    }
  }
}

/**
 * POST a JSON body and return the parsed envelope plus the raw text.
 *
 * The raw text is returned because it is the only thing `Digest` signs — a caller wanting
 * to re-verify, log, or record a fixture needs the bytes, not a re-serialization.
 */
export async function zingalaPost<T extends ZingalaEnvelope>(
  config: ZingalaConfig,
  path: string,
  body: Record<string, unknown>,
  label: string,
  options: ZingalaRequestOptions = {},
): Promise<{ data: T; raw: string }> {
  requireCredentials(config);
  const url = `${resolveZingalaOrigin(config)}${path}`;

  // `top_vender_id` is accepted by most endpoints and only matters when the 撥款對象
  // differs from the merchant's default company, so it is injected rather than threaded
  // through every call site.
  const payload =
    config.topVenderId && !("top_vender_id" in body)
      ? { ...body, top_vender_id: config.topVenderId }
      : body;

  let response: Response;
  let rawText: string;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "0Card-Merchant-Id": config.merchantId,
        "0Card-API-Key": config.apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    rawText = await response.text();
  } catch (cause) {
    throw new PaymentError("NETWORK", `${MESSAGE_PREFIX} ${label} 連線失敗`, PROVIDER, {
      cause,
      raw: { url },
    });
  }

  const digest = response.headers.get("digest");
  if (!digest && !options.allowUnsignedResponse) {
    throw new PaymentError(
      "AUTH",
      `${MESSAGE_PREFIX} ${label} 回應沒有 Digest 簽章，無法確認來源`,
      PROVIDER,
      { raw: { status: response.status, body: rawText.slice(0, 400) } },
    );
  }
  if (digest && !verifyDigest(rawText, digest, config.aesKey)) {
    throw new PaymentError(
      "AUTH",
      `${MESSAGE_PREFIX} ${label} Digest 驗證失敗（回應可能被竄改，或 aesKey 不符）`,
      PROVIDER,
      { raw: { status: response.status, body: rawText.slice(0, 400) } },
    );
  }

  let data: T;
  try {
    data = JSON.parse(rawText) as T;
  } catch (cause) {
    throw new PaymentError(
      "PROVIDER",
      `${MESSAGE_PREFIX} ${label} 回應不是 JSON（HTTP ${response.status}）`,
      PROVIDER,
      { cause, raw: { status: response.status, body: rawText.slice(0, 400) } },
    );
  }

  // Every recorded failure still came back as HTTP 200 with a non-000 `result`, so the
  // status code is not the signal — but a non-2xx with no usable result must not pass.
  if (typeof data.result !== "string") {
    throw new PaymentError(
      "PROVIDER",
      `${MESSAGE_PREFIX} ${label} 回應缺少 result 欄位（HTTP ${response.status}）`,
      PROVIDER,
      { raw: data },
    );
  }

  if (data.result !== ZINGALA_SUCCESS) {
    const described = describeResult(data.result, data.result_message);
    throw new PaymentError(
      described.code,
      `${MESSAGE_PREFIX} ${label} 失敗 (result=${data.result}): ${described.message}`,
      PROVIDER,
      { rawCode: data.result, rawMessage: data.result_message, raw: data },
    );
  }

  return { data, raw: rawText };
}

/**
 * POST and return the raw bytes — for `download_aprvnotice_pdf`, which answers
 * `application/octet-stream` rather than JSON.
 *
 * ⚠️ No `Digest` check is possible on a binary body in the same way, and 中租 does not
 * document one here; an error still arrives as a JSON envelope, so that case is
 * normalized before the bytes are returned.
 */
export async function zingalaPostForBytes(
  config: ZingalaConfig,
  path: string,
  body: Record<string, unknown>,
  label: string,
  options: ZingalaRequestOptions = {},
): Promise<Uint8Array> {
  requireCredentials(config);
  const url = `${resolveZingalaOrigin(config)}${path}`;

  let response: Response;
  let buffer: ArrayBuffer;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "0Card-Merchant-Id": config.merchantId,
        "0Card-API-Key": config.apiKey,
      },
      body: JSON.stringify(
        config.topVenderId && !("top_vender_id" in body)
          ? { ...body, top_vender_id: config.topVenderId }
          : body,
      ),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    buffer = await response.arrayBuffer();
  } catch (cause) {
    throw new PaymentError("NETWORK", `${MESSAGE_PREFIX} ${label} 連線失敗`, PROVIDER, { cause });
  }

  const bytes = new Uint8Array(buffer);
  const contentType = response.headers.get("content-type") ?? "";

  // A failure comes back as the ordinary JSON envelope even from this endpoint, so sniff
  // for it rather than handing the caller a "PDF" that is really an error message.
  if (contentType.includes("json") || looksLikeJson(bytes)) {
    const text = new TextDecoder().decode(bytes);
    let parsed: ZingalaEnvelope | null = null;
    try {
      parsed = JSON.parse(text) as ZingalaEnvelope;
    } catch {
      /* fall through to the generic error below */
    }
    if (parsed && typeof parsed.result === "string" && parsed.result !== ZINGALA_SUCCESS) {
      const described = describeResult(parsed.result, parsed.result_message);
      throw new PaymentError(
        described.code,
        `${MESSAGE_PREFIX} ${label} 失敗 (result=${parsed.result}): ${described.message}`,
        PROVIDER,
        { rawCode: parsed.result, rawMessage: parsed.result_message, raw: parsed },
      );
    }
    throw new PaymentError(
      "PROVIDER",
      `${MESSAGE_PREFIX} ${label} 預期二進位檔案，卻收到 JSON`,
      PROVIDER,
      { raw: { body: text.slice(0, 400) } },
    );
  }

  if (bytes.length === 0) {
    throw new PaymentError("PROVIDER", `${MESSAGE_PREFIX} ${label} 回應是空的`, PROVIDER);
  }
  return bytes;
}

function looksLikeJson(bytes: Uint8Array): boolean {
  const first = bytes.find((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09);
  return first === 0x7b || first === 0x5b; // '{' or '['
}
