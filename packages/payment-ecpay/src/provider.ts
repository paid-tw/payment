import crypto from "node:crypto";
import {
  assertSupports,
  type Capability,
  PaymentError,
  type PaymentErrorCode,
  type CreatePaymentRequest,
  type GetPaymentRequest,
  type PaymentMethod,
  type PaymentProvider,
  type ProviderRuntimeConfig,
  type RefundPaymentRequest,
  type NormalizedPaymentData,
} from "@paid-tw/payment";
import { resolveEcpayOrigin } from "./config.js";

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "CREATE_PAYMENT",
  "GET_PAYMENT",
  "REFUND_PAYMENT",
]);

/** Outcome of a DoAction credit-card refund (Action=R). */
export interface EcpayRefundResult {
  tradeNo: string;
  rtnCode: string;
  rtnMsg: string;
  amount: number;
  raw: Record<string, string>;
}

/**
 * ECPay's AioCheckOut is a browser-redirect flow, not a server-to-server call:
 * the merchant auto-submits this form to hand the buyer off to ECPay's cashier.
 * createPayment returns the endpoint + signed params rather than a settled txn.
 */
export interface EcpayCheckoutForm {
  action: string;
  method: "POST";
  params: Record<string, string>;
}

/**
 * ECPay narrows the contract's `Promise<unknown>` create/refund returns to its
 * concrete shapes. It's still assignable to {@link PaymentProvider} (covariant
 * returns), so the factory registry accepts it unchanged.
 */
export interface EcpayProvider extends PaymentProvider {
  createPayment(input: CreatePaymentRequest): Promise<EcpayCheckoutForm>;
  refundPayment(input: RefundPaymentRequest): Promise<EcpayRefundResult>;
}

/**
 * ECPay (綠界科技) All-in-One adapter. Credentials + host live on the instance;
 * `baseUrl` (or the sandbox flag) selects the gateway origin so tests can point
 * it at an MSW mock. AioCheckOut (create), QueryTradeInfo/V5 (get) and DoAction
 * credit-card refund are implemented.
 */
export function createEcpayProvider(config: ProviderRuntimeConfig): EcpayProvider {
  const origin = resolveEcpayOrigin(config);

  /** POST QueryTradeInfo/V5 and return the verified, parsed field set. */
  const queryTradeInfo = async (merTradeNo: string): Promise<Record<string, string>> => {
    const { merchantId, hashKey, hashIv } = requireCredentials(config);
    const params: Record<string, string> = {
      MerchantID: merchantId,
      MerchantTradeNo: merTradeNo,
      TimeStamp: String(Math.floor(Date.now() / 1000)),
    };
    params.CheckMacValue = computeCheckMacValue(params, hashKey, hashIv);

    const text = await postForm(`${origin}/Cashier/QueryTradeInfo/V5`, params, "QueryTradeInfo");
    const parsed = Object.fromEntries(new URLSearchParams(text).entries());
    verifyResponseMac(parsed, hashKey, hashIv);
    assertQueryOk(parsed);
    return parsed;
  };

  return {
    name: "ecpay",
    capabilities: CAPABILITIES,

    async createPayment(input: CreatePaymentRequest): Promise<EcpayCheckoutForm> {
      assertSupports("ecpay", CAPABILITIES, "CREATE_PAYMENT");
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      if (input.currency && input.currency !== "TWD") {
        throw new PaymentError("VALIDATION", "ECPay AioCheckOut 僅支援 TWD", "ecpay");
      }
      if (!input.notifyUrl) {
        throw new PaymentError(
          "VALIDATION",
          "ECPay 需要 notify-url 作為 ReturnURL（付款結果通知）",
          "ecpay",
        );
      }
      // ECPay caps MerchantTradeNo at 20 alphanumeric chars; a rejected order
      // would also break the later getPayment/refund lookups (they resolve by it).
      if (!/^[A-Za-z0-9]{1,20}$/.test(input.orderId)) {
        throw new PaymentError(
          "VALIDATION",
          `ECPay MerchantTradeNo 需為 1-20 碼英數字（收到 "${input.orderId}"）`,
          "ecpay",
        );
      }

      const params: Record<string, string> = {
        MerchantID: merchantId,
        MerchantTradeNo: input.orderId,
        MerchantTradeDate: taipeiTradeDate(),
        PaymentType: "aio",
        TotalAmount: String(Math.round(input.amount)),
        TradeDesc: input.itemDesc ?? "paid",
        ItemName: input.itemDesc ?? input.orderId,
        ReturnURL: input.notifyUrl,
        ChoosePayment: mapChoosePayment(input.method),
        EncryptType: "1",
      };
      if (input.returnUrl) {
        params.OrderResultURL = input.returnUrl;
        params.ClientBackURL = input.returnUrl;
      }
      params.CheckMacValue = computeCheckMacValue(params, hashKey, hashIv);

      return { action: `${origin}/Cashier/AioCheckOut/V5`, method: "POST", params };
    },

    async refundPayment(input: RefundPaymentRequest): Promise<EcpayRefundResult> {
      assertSupports("ecpay", CAPABILITIES, "REFUND_PAYMENT");
      const { merchantId, hashKey, hashIv } = requireCredentials(config);

      // DoAction needs ECPay's TradeNo + the paid amount; resolve them from the
      // order first. ECPay's DoAction refund is credit-card only.
      const info = await queryTradeInfo(input.orderId);
      const tradeNo = info.TradeNo;
      if (!tradeNo) {
        throw new PaymentError("NOT_FOUND", `ECPay 查無訂單 ${input.orderId} 的 TradeNo`, "ecpay", {
          raw: info,
        });
      }
      if (info.PaymentType && !info.PaymentType.startsWith("Credit")) {
        throw new PaymentError("VALIDATION", "ECPay 退款（DoAction）僅支援信用卡", "ecpay", {
          raw: info,
        });
      }
      const amount = input.amount ?? asNumber(info.TradeAmt);
      if (amount === undefined) {
        throw new PaymentError("VALIDATION", "ECPay 退款需要金額（--amount）", "ecpay");
      }

      const params: Record<string, string> = {
        MerchantID: merchantId,
        MerchantTradeNo: input.orderId,
        TradeNo: tradeNo,
        Action: "R",
        TotalAmount: String(Math.round(amount)),
      };
      params.CheckMacValue = computeCheckMacValue(params, hashKey, hashIv);

      const text = await postForm(`${origin}/CreditDetail/DoAction`, params, "DoAction");
      const parsed = Object.fromEntries(new URLSearchParams(text).entries());
      verifyResponseMac(parsed, hashKey, hashIv);

      const rtnCode = parsed.RtnCode ?? "";
      if (rtnCode !== "1") {
        throw new PaymentError(
          "PROVIDER",
          `ECPay DoAction 失敗: ${parsed.RtnMsg ?? rtnCode}`,
          "ecpay",
          { rawCode: rtnCode, rawMessage: parsed.RtnMsg, raw: parsed },
        );
      }
      return {
        tradeNo,
        rtnCode,
        rtnMsg: parsed.RtnMsg ?? "",
        amount: Math.round(amount),
        raw: parsed,
      };
    },

    async getPayment(input: GetPaymentRequest): Promise<NormalizedPaymentData> {
      assertSupports("ecpay", CAPABILITIES, "GET_PAYMENT");
      if (!input.merTradeNo) {
        throw new PaymentError("VALIDATION", "ECPay 查詢需要提供 MerchantTradeNo（--id）", "ecpay");
      }
      return normalizeQueryInfo(await queryTradeInfo(input.merTradeNo));
    },
  };
}

/** POST form-urlencoded params; normalize transport/HTTP/`code|message` errors. */
async function postForm(
  url: string,
  params: Record<string, string>,
  label: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  } catch (err) {
    throw new PaymentError("NETWORK", `ECPay ${label} 連線失敗`, "ecpay", { cause: err });
  }

  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER",
      `ECPay ${label} failed: ${response.status} ${response.statusText}`,
      "ecpay",
      { rawCode: String(response.status) },
    );
  }

  const text = await response.text();
  if (process.env.PAID_DEBUG === "1") {
    console.error(`[ecpay] ${label} response:`, text);
  }

  // Some ECPay endpoints answer errors as `0|Message` instead of a field set.
  const pipe = /^(\d+)\|(.+)$/.exec(text.trim());
  if (pipe) {
    throw new PaymentError("PROVIDER", `${pipe[1]}: ${pipe[2]}`, "ecpay", {
      rawCode: pipe[1],
      rawMessage: pipe[2],
      raw: text,
    });
  }

  return text;
}

function requireCredentials(config: ProviderRuntimeConfig) {
  const { merchantId, hashKey, hashIv } = config;
  if (!merchantId || !hashKey || !hashIv) {
    throw new PaymentError("AUTH", "缺少 ECPay 憑證（MerchantID / HashKey / HashIV）", "ecpay");
  }
  return { merchantId, hashKey, hashIv };
}

/**
 * Classic AIO CheckMacValue: sort params A→Z (case-insensitive), wrap as
 * `HashKey=<hk>&<sorted>&HashIV=<hiv>`, .NET-style URL-encode + lowercase, then
 * SHA256 → uppercase. Verified against ECPay's documented worked example
 * (see ecpay.test.ts). `CheckMacValue` itself is never part of the input.
 */
export function computeCheckMacValue(
  params: Record<string, string>,
  hashKey: string,
  hashIv: string,
): string {
  const sorted = Object.keys(params)
    .filter((k) => k !== "CheckMacValue")
    .sort((a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
    )
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const raw = `HashKey=${hashKey}&${sorted}&HashIV=${hashIv}`;
  const encoded = dotNetUrlEncode(raw);
  return crypto.createHash("sha256").update(encoded).digest("hex").toUpperCase();
}

/** ECPay's ChoosePayment for a generic method; anything else offers all methods. */
function mapChoosePayment(method?: PaymentMethod): string {
  switch (method) {
    case "card":
      return "Credit";
    case "atm":
      return "ATM";
    case "cvs":
      return "CVS";
    default:
      return "ALL";
  }
}

/** MerchantTradeDate in ECPay's `yyyy/MM/dd HH:mm:ss`, in Asia/Taipei. */
function taipeiTradeDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Mirror ECPay's .NET/PHP URL-encode. encodeURIComponent already leaves
 * `- _ . ! * ( )` literal (which ECPay's encoder also keeps) and uppercases its
 * %XX; ECPay additionally percent-encodes `'`→%27 and `~`→%7E (encodeURIComponent
 * leaves those literal), uses `+` for space, and lowercases the whole string.
 */
function dotNetUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/'/g, "%27")
    .replace(/~/g, "%7E")
    .toLowerCase()
    .replace(/%20/g, "+");
}

function verifyResponseMac(parsed: Record<string, string>, hashKey: string, hashIv: string) {
  const returned = parsed.CheckMacValue;
  if (!returned) return; // no MAC to verify (some minimal responses)
  const expected = computeCheckMacValue(parsed, hashKey, hashIv);
  if (expected !== returned.toUpperCase()) {
    throw new PaymentError("PROVIDER", "ECPay 回應 CheckMacValue 驗證失敗", "ecpay", {
      raw: parsed,
    });
  }
}

/**
 * QueryTradeInfo answers HTTP 200 for *every* well-formed request; a missing or
 * malformed order comes back with all fields blank and an error TradeStatus
 * (verified live against the stage merchant, see ecpay-fixtures.ts). Only 0
 * (unpaid) and 1 (paid) are real payment states — everything else is normalized
 * to a PaymentError so callers don't mistake `10200047` for a status.
 */
function assertQueryOk(parsed: Record<string, string>): void {
  const status = parsed.TradeStatus;
  if (status === "0" || status === "1") return;
  const mapped = status ? QUERY_STATUS_ERRORS[status] : undefined;
  throw new PaymentError(
    mapped?.code ?? "PROVIDER",
    `ECPay ${mapped?.message ?? `查詢失敗 (TradeStatus=${status})`}`,
    "ecpay",
    { rawCode: status, rawMessage: mapped?.message, raw: parsed },
  );
}

/**
 * ECPay QueryTradeInfo error TradeStatus codes → normalized PaymentError code.
 * Extend as new codes are observed; anything unmapped falls through to PROVIDER.
 */
const QUERY_STATUS_ERRORS: Record<string, { code: PaymentErrorCode; message: string }> = {
  "10200047": { code: "NOT_FOUND", message: "查無交易資料" },
  "10200095": { code: "NOT_FOUND", message: "訂單未成立" },
  "10200052": { code: "VALIDATION", message: "MerchantTradeNo 錯誤" },
};

function normalizeQueryInfo(parsed: Record<string, string>): NormalizedPaymentData {
  return {
    status: mapTradeStatus(parsed.TradeStatus),
    method: mapPaymentType(parsed.PaymentType),
    amount: asNumber(parsed.TradeAmt),
    paidAt: parsed.PaymentDate || undefined,
    tradeNo: parsed.TradeNo || undefined,
    merTradeNo: parsed.MerchantTradeNo || undefined,
    raw: parsed,
  };
}

/** QueryTradeInfo TradeStatus for a real order: 0 = 已建立未付款, 1 = 已付款. */
function mapTradeStatus(value?: string) {
  switch (value) {
    case "1":
      return "paid";
    case "0":
      return "unpaid";
    default:
      return value ?? "unknown";
  }
}

/** Collapse ECPay's PaymentType (e.g. `Credit_CreditCard`, `ATM_TAISHIN`) to a family. */
function mapPaymentType(value?: string) {
  if (!value) return "unknown";
  const family = value.split("_")[0];
  switch (family) {
    case "Credit":
      return "card";
    case "ATM":
      return "atm";
    case "CVS":
      return "cvs";
    case "BARCODE":
      return "barcode";
    case "WebATM":
      return "webatm";
    default:
      return family ?? value;
  }
}

function asNumber(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const num = Number(input);
  return Number.isNaN(num) ? undefined : num;
}
