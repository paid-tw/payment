import { setupServer } from "msw/node";
import type { NewebpayProviderConfig } from "../config.js";
import { checkCode, decryptTradeInfo, encryptTradeInfo, tradeSha } from "../crypto.js";
import { createNewebpayProvider } from "../provider.js";

/**
 * Fixed host + test credentials shared by all NewebPay MSW handlers.
 *
 * The credentials are the NDNF-1.2.3 manual's own sandbox shop (printed in the
 * manual — public documentation values, not secrets). Using them lets the
 * suite replay the manual's gateway-produced ciphertexts verbatim.
 */
export const BASE = "https://newebpay.test";
export const MERCHANT = "MS127874575";
export const KEY = "Fs5cX1TGqYM2PpdbE14a9H83YQSQF5jn"; // 32 bytes (AES-256)
export const IV = "C6AcmfqJILwgnhIP"; // 16 bytes

export const QUERY_URL = `${BASE}/API/QueryTradeInfo`;
export const CLOSE_URL = `${BASE}/API/CreditCard/Close`;
export const CANCEL_URL = `${BASE}/API/CreditCard/Cancel`;

export const server = setupServer();

/** A provider pointed at the mocked host. */
export function testProvider(overrides: Partial<NewebpayProviderConfig> = {}) {
  return createNewebpayProvider({
    merchantId: MERCHANT,
    hashKey: KEY,
    hashIv: IV,
    baseUrl: BASE,
    ...overrides,
  });
}

/** Parse a captured envelope request (`MerchantID_` + `PostData_`). */
export function parseEnvelopeRequest(bodyText: string) {
  const form = new URLSearchParams(bodyText);
  const postData = form.get("PostData_") ?? "";
  return {
    merchantId: form.get("MerchantID_"),
    postData,
    params: Object.fromEntries(new URLSearchParams(decryptTradeInfo(postData, KEY, IV)).entries()),
  };
}

/** Decrypted fixture payload values are scalars (the manual prints some nulls). */
type FixtureResult = Record<string, string | number | null | undefined>;

/** Compute the response CheckCode the way the gateway does (4 fields, ksort). */
export function responseCheckCode(result: FixtureResult): string {
  return checkCode(
    {
      Amt: String(result.Amt ?? ""),
      MerchantID: String(result.MerchantID ?? ""),
      MerchantOrderNo: String(result.MerchantOrderNo ?? ""),
      TradeNo: String(result.TradeNo ?? ""),
    },
    KEY,
    IV,
  );
}

/** A SUCCESS query envelope whose Result carries a freshly computed CheckCode. */
export function querySuccess(result: FixtureResult) {
  return {
    Status: "SUCCESS",
    Message: "查詢成功",
    Result: { ...result, CheckCode: responseCheckCode(result) },
  };
}

/** A SUCCESS Close/Cancel envelope; pass `checkCode: true` to sign the Result. */
export function actionSuccess(
  result: FixtureResult,
  options: { status?: string; message?: string; checkCode?: boolean } = {},
) {
  return {
    Status: options.status ?? "SUCCESS",
    Message: options.message ?? "成功",
    Result: options.checkCode ? { ...result, CheckCode: responseCheckCode(result) } : result,
  };
}

/**
 * An error envelope (Status = a NewebPay code, e.g. TRA10021). Mirrors the
 * shape recorded live 2026-08-07: query errors carry `Result` as an EMPTY
 * ARRAY plus the gateway's own message text.
 */
export function gatewayError(status: string, message = "") {
  return { Status: status, Message: message, Result: [] };
}

/**
 * Build a notify envelope the way the gateway does: encrypt the decrypted
 * payload with the test key, sign the ciphertext with TradeSha.
 */
export function notifyEnvelope(
  decryptedPayload: string,
  overrides: Partial<
    Record<"Status" | "MerchantID" | "Version" | "TradeInfo" | "TradeSha" | "EncryptType", string>
  > = {},
): Record<string, string> {
  const tradeInfo = overrides.TradeInfo ?? encryptTradeInfo(decryptedPayload, KEY, IV);
  return {
    Status: "SUCCESS",
    MerchantID: MERCHANT,
    Version: "2.0",
    TradeInfo: tradeInfo,
    TradeSha: tradeSha(tradeInfo, KEY, IV),
    ...overrides,
  };
}
