import crypto from "node:crypto";
import {
  assertSupports,
  type Capability,
  PaymentError,
  type PaymentErrorCode,
  type GetPaymentRequest,
  type NormalizedPaymentData,
  type PaymentProvider,
  type ProviderRuntimeConfig,
} from "@paid-tw/payment";

const PAYUNI_ORIGINS = {
  sandbox: "https://sandbox-api.payuni.com.tw",
  production: "https://api.payuni.com.tw",
} as const;

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(["GET_PAYMENT"]);

/**
 * PAYUNi (統一金流) adapter. Credentials + host live on the instance; `baseUrl`
 * (or the sandbox flag) selects the gateway origin so tests can point it at an
 * MSW mock. Only trade-query is implemented today — create/refund are declared
 * unsupported and reject with a normalized {@link PaymentError}.
 */
export function createPayuniProvider(config: ProviderRuntimeConfig): PaymentProvider {
  const origin = (
    config.baseUrl ?? (config.sandbox ? PAYUNI_ORIGINS.sandbox : PAYUNI_ORIGINS.production)
  ).replace(/\/+$/, "");

  return {
    name: "payuni",
    capabilities: CAPABILITIES,

    async createPayment() {
      assertSupports("payuni", CAPABILITIES, "CREATE_PAYMENT");
      throw new PaymentError("UNSUPPORTED", "PAYUNi createPayment 尚未實作", "payuni");
    },

    async refundPayment() {
      assertSupports("payuni", CAPABILITIES, "REFUND_PAYMENT");
      throw new PaymentError("UNSUPPORTED", "PAYUNi refundPayment 尚未實作", "payuni");
    },

    async getPayment(input: GetPaymentRequest): Promise<NormalizedPaymentData> {
      assertSupports("payuni", CAPABILITIES, "GET_PAYMENT");
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      if (!input.merTradeNo && !input.tradeNo) {
        throw new PaymentError("VALIDATION", "PAYUNi 查詢需要提供 MerTradeNo 或 TradeNo", "payuni");
      }

      const params = new URLSearchParams({
        MerID: merchantId,
        Timestamp: String(Math.floor(Date.now() / 1000)),
      });
      if (input.merTradeNo) params.set("MerTradeNo", input.merTradeNo);
      if (input.tradeNo) params.set("TradeNo", input.tradeNo);

      const encryptInfo = encrypt(params.toString(), hashKey, hashIv);
      const hashInfo = generateHashInfo(encryptInfo, hashKey, hashIv);

      let response: Response;
      try {
        response = await fetch(`${origin}/api/trade/query`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "payuni",
          },
          body: new URLSearchParams({
            MerID: merchantId,
            Version: "2.0",
            EncryptInfo: encryptInfo,
            HashInfo: hashInfo,
          }),
        });
      } catch (err) {
        throw new PaymentError("NETWORK", "PAYUNi query 連線失敗", "payuni", { cause: err });
      }

      if (!response.ok) {
        throw new PaymentError(
          "PROVIDER",
          `PAYUNi query failed: ${response.status} ${response.statusText}`,
          "payuni",
          { rawCode: String(response.status) },
        );
      }

      const result = (await response.json()) as PayuniQueryResponse;
      if (process.env.PAID_DEBUG === "1") {
        console.error("[payuni] status:", response.status);
        console.error("[payuni] response:", JSON.stringify(result));
      }

      if (result.Status && result.Status !== "SUCCESS") {
        const rawMessage = PAYUNI_QUERY_ERRORS[result.Status] ?? result.Message ?? "未知錯誤";
        throw new PaymentError(
          mapQueryStatusToCode(result.Status),
          `${result.Status}: ${rawMessage}`,
          "payuni",
          { rawCode: result.Status, rawMessage, raw: result },
        );
      }

      const decrypted = result.EncryptInfo
        ? tryDecrypt(result.EncryptInfo, hashKey, hashIv)
        : undefined;
      if (decrypted?.error) {
        throw new PaymentError("PROVIDER", `PAYUNi 回應解密失敗: ${decrypted.error}`, "payuni", {
          raw: result,
        });
      }

      const parsed = decrypted?.value ? parseDecryptedPayload(decrypted.value) : undefined;
      if (!parsed) {
        throw new PaymentError("PROVIDER", "PAYUNi 回應缺少可解析資料", "payuni", { raw: result });
      }
      return normalizeQueryResult(parsed);
    },
  };
}

function requireCredentials(config: ProviderRuntimeConfig) {
  const { merchantId, hashKey, hashIv } = config;
  if (!merchantId || !hashKey || !hashIv) {
    throw new PaymentError("AUTH", "缺少 PAYUNi 憑證（MerchantID / HashKey / HashIV）", "payuni");
  }
  return { merchantId, hashKey, hashIv };
}

/** Map a PAYUNi `QUERYxxxxx` status onto a stable {@link PaymentErrorCode}. */
function mapQueryStatusToCode(status: string): PaymentErrorCode {
  switch (status) {
    case "QUERY01002": // 資料 HASH 比對不符合
    case "QUERY01005": // 查無符合商店資料
      return "AUTH";
    case "QUERY01003": // 資料解密失敗
    case "QUERY01004": // 解密資料不存在
      return "PROVIDER";
    case "QUERY03001": // 查無符合訂單資料
      return "NOT_FOUND";
    default:
      // QUERY01001 / QUERY02xxx 皆為請求參數層級錯誤
      return status.startsWith("QUERY01") || status.startsWith("QUERY02")
        ? "VALIDATION"
        : "PROVIDER";
  }
}

function encrypt(data: string, hashKey: string, hashIv: string): string {
  const key = Buffer.from(hashKey.trim(), "utf8");
  const iv = Buffer.from(hashIv.trim(), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = `${encrypted.toString("base64")}:::${tag.toString("base64")}`;
  return Buffer.from(combined, "utf8").toString("hex");
}

function generateHashInfo(encryptInfo: string, hashKey: string, hashIv: string): string {
  return crypto
    .createHash("sha256")
    .update(`${hashKey}${encryptInfo}${hashIv}`)
    .digest("hex")
    .toUpperCase();
}

function tryDecrypt(encryptedHex: string, hashKey: string, hashIv: string) {
  try {
    const raw = Buffer.from(encryptedHex, "hex").toString("utf8");
    const [encryptedBase64, tagBase64] = raw.split(":::");
    if (!encryptedBase64 || !tagBase64) {
      return { error: "invalid_encrypted_format" };
    }
    const key = Buffer.from(hashKey.trim(), "utf8");
    const iv = Buffer.from(hashIv.trim(), "utf8");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedBase64, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return { value: decrypted };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "decrypt_failed" };
  }
}

type PayuniQueryResponse = {
  Status?: string;
  Message?: string;
  EncryptInfo?: string;
  HashInfo?: string;
  Version?: string;
  [key: string]: unknown;
};

type PayuniQueryResult = Record<string, unknown>;

/**
 * PAYUNi's decrypted payload comes in three observed shapes: a JSON object, a
 * querystring, or a querystring with flattened `Result[0][Field]` keys. This
 * normalizes all three into `{ Result: [...] }`.
 */
function parseDecryptedPayload(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // fall through to querystring parse
    }
  }

  const params = new URLSearchParams(trimmed);
  const obj: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    obj[key] = key === "Result" ? (tryParseJson(value) ?? value) : value;
  }

  const result0 = extractFromFlatKeys(obj);
  if (Object.keys(result0).length) {
    obj.Result = [result0];
  }
  return obj;
}

function tryParseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function normalizeQueryResult(parsed: Record<string, unknown>): NormalizedPaymentData {
  const result = extractFirstResult(parsed);
  return {
    status: mapTradeStatus(asString(result?.TradeStatus)),
    method: mapPaymentType(asString(result?.PaymentType)),
    amount: asNumber(result?.TradeAmt),
    paidAt: asString(result?.PaymentDay),
    tradeNo: asString(result?.TradeNo),
    merTradeNo: asString(result?.MerTradeNo),
    raw: result,
  };
}

function extractFirstResult(parsed: Record<string, unknown>): PayuniQueryResult | undefined {
  const result = parsed.Result;
  if (Array.isArray(result)) {
    return result[0] as PayuniQueryResult | undefined;
  }
  if (result && typeof result === "object") {
    return result as PayuniQueryResult;
  }
  const flat = extractFromFlatKeys(parsed);
  return Object.keys(flat).length ? flat : (parsed as PayuniQueryResult);
}

function extractFromFlatKeys(parsed: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const re = /^Result\[(\d+)\]\[(.+)\]$/;
  for (const [key, value] of Object.entries(parsed)) {
    const match = key.match(re);
    if (!match) continue;
    if (Number(match[1]) !== 0) continue;
    const field = match[2];
    if (!field) continue;
    out[field] = value;
  }
  return out;
}

function mapTradeStatus(value?: string) {
  switch (value) {
    case "1":
      return "paid";
    case "2":
      return "failed";
    case "3":
      return "canceled";
    case "4":
      return "expired";
    case "8":
      return "pending";
    case "9":
      return "unpaid";
    case "0":
      return "initialized";
    default:
      return value ?? "unknown";
  }
}

function mapPaymentType(value?: string) {
  switch (value) {
    case "1":
      return "card";
    case "2":
      return "atm";
    case "3":
      return "cvs";
    case "9":
      return "linepay";
    case "11":
      return "jkopay";
    default:
      return value ?? "unknown";
  }
}

function asString(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  return String(input);
}

function asNumber(input: unknown): number | undefined {
  // Guard "" too: Number("") is 0, which would misreport a blank TradeAmt (an
  // unpaid/initialized order) as a zero-amount transaction rather than unknown.
  if (input === null || input === undefined || input === "") return undefined;
  const num = Number(input);
  return Number.isNaN(num) ? undefined : num;
}

const PAYUNI_QUERY_ERRORS: Record<string, string> = {
  QUERY01001: "未有商店代號",
  QUERY01002: "資料 HASH 比對不符合",
  QUERY01003: "資料解密失敗",
  QUERY01004: "解密資料不存在",
  QUERY01005: "查無符合商店資料",
  QUERY01006: "網路連線異常",
  QUERY02001: "未有商店代號",
  QUERY02002: "商店訂單或訂單編號，請擇一送入",
  QUERY02003: "商店訂單編號，超過長度限制",
  QUERY02004: "商店訂單編號，格式錯誤",
  QUERY02005: "訂單編號，超過長度限制",
  QUERY02006: "訂單編號，格式錯誤",
  QUERY02007: "未有時間戳記",
  QUERY02008: "時間戳記，僅可輸入整數",
  QUERY02009: "時間戳記，已過期",
  QUERY02010: "未有查詢類別",
  QUERY02011: "非可使用的查詢類別",
  QUERY02012: "參數格式錯誤(QueryNo)",
  QUERY02013: "超過單次可查詢筆數上限",
  QUERY03001: "查無符合訂單資料",
  QUERY04001: "未有API處理結果",
  QUERY04002: "回傳加密失敗",
};
