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
  type RefundPaymentRequest,
  type NormalizedPaymentData,
} from "@paid-tw/payment";
import { type EcpayProviderConfig, resolveEcpayOrigin } from "./config.js";
import { type EcpayNotifyInput, type EcpayPaymentNotify, verifyPaymentNotify } from "./notify.js";

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "CREATE_PAYMENT",
  "GET_PAYMENT",
  "REFUND_PAYMENT",
]);

/**
 * CreditDetail/DoAction actions (docs p=2885):
 * - `C` 關帳 / capture
 * - `R` 退刷 / refund
 * - `E` 取消關帳
 * - `N` 放棄 (pre-close void)
 */
export type EcpayCreditAction = "C" | "R" | "E" | "N";

export interface EcpayCreditDoActionInput {
  orderId: string;
  action: EcpayCreditAction;
  /** Defaults to TradeAmt from QueryTradeInfo when omitted. */
  amount?: number;
  /** Skip the pre-query when the ECPay TradeNo is already known. */
  tradeNo?: string;
}

/** Shared result for all DoAction ops (including refund). */
export interface EcpayCreditDoActionResult {
  action: EcpayCreditAction;
  tradeNo: string;
  rtnCode: string;
  rtnMsg: string;
  amount: number;
  raw: Record<string, string>;
}

/** @deprecated Prefer {@link EcpayCreditDoActionResult}; kept for refundPayment shape. */
export type EcpayRefundResult = Omit<EcpayCreditDoActionResult, "action">;

export interface EcpayCreditTradeQueryInput {
  /**
   * 信用卡授權單號 — notify field `gwsr` when NeedExtraPaidInfo=Y, or vendor console.
   * @see https://developers.ecpay.com.tw/?p=2894
   */
  creditRefundId: string | number;
  amount: number;
  /** Overrides {@link EcpayProviderConfig.creditCheckCode}. */
  creditCheckCode?: string | number;
}

export interface EcpayCreditCloseRow {
  status?: string;
  amount?: number;
  sno?: string;
  datetime?: string;
}

/** Normalized CreditDetail/QueryTrade/V2 body. */
export interface EcpayCreditTradeDetail {
  tradeId?: string;
  amount?: number;
  closedAmount?: number;
  authTime?: string;
  /** e.g. 已授權 / 已關帳 / 已取消 / 操作取消 */
  status?: string;
  closeData: EcpayCreditCloseRow[];
  raw: unknown;
}

/**
 * The AIO optional fields worth typing — the 13 "共同參數" every payment method accepts
 * beyond the required ones.
 *
 * Method-specific fields (ATM `ExpireDate`, CVS `StoreExpireDate`/`Desc_1..4`, credit
 * `CreditInstallment`/`Redeem`/`Period*`, BNPL, TWQR …) live on {@link
 * EcpayAioFields.params} instead: there are dozens, they change per method, and
 * enumerating them here would mean a release every time ECPay adds one.
 */
export interface EcpayAioCommonFields {
  /** 特店旗下店舖代號. */
  storeId?: string;
  /** Button link back to the merchant from ECPay's page. */
  clientBackUrl?: string;
  /** 商品銷售網址. */
  itemUrl?: string;
  remark?: string;
  /** 付款子項目 — pins a sub-method and skips ECPay's chooser. */
  chooseSubPayment?: string;
  /** Client-side result redirect. Distinct from `clientBackUrl`. */
  orderResultUrl?: string;
  /** Hide payment methods on the chooser, e.g. `"Credit#WebATM"`. */
  ignorePayment?: string;
  platformId?: string;
  customField1?: string;
  customField2?: string;
  customField3?: string;
  customField4?: string;
  /** `ENG` / `KOR` / `JPN` / `CHI`; omit for 繁中. */
  language?: string;
}

/**
 * Take-number notify hooks for ATM / CVS / BARCODE.
 *
 * Both fire when the **order is created**, not when it is paid, and carry the payment
 * code (bank + virtual account, or 繳費代碼, or barcode segments).
 *
 * ⚠️ Verify that notify with {@link import("./notify.js").verifyEcpayPaymentInfoNotify},
 * **not** `verifyPaymentNotify`: 取號成功 is `RtnCode 2` for ATM and `10100073` for
 * CVS/BARCODE, so the payment-result verifier would report a successful 取號 as a
 * failure.
 */
export interface EcpayTakeNumberHooks {
  /** Server-side POST with the payment code. */
  paymentInfoUrl?: string;
  /** Browser redirect carrying the same information. */
  clientRedirectUrl?: string;
}

export interface EcpayAioFields extends EcpayAioCommonFields, EcpayTakeNumberHooks {
  /**
   * Escape hatch for any other AIO field, merged verbatim into the form before the
   * CheckMacValue is computed — so method-specific parameters work without this
   * adapter having to know about them.
   *
   * Values are stringified; `undefined` entries are dropped. Fields this adapter
   * derives or signs (`MerchantID`, `MerchantTradeNo`, `TotalAmount`, `ReturnURL`,
   * `PaymentType`, `EncryptType`, `ChoosePayment`, `CheckMacValue`) are **rejected**
   * rather than silently overridden — two sources of truth for a signed field is how
   * you get a MAC that does not match what you meant to send.
   *
   * @example
   * // ATM: 7-day deadline plus the take-number notify
   * { params: { ExpireDate: 7 } , paymentInfoUrl: "https://shop/paid-info" }
   * @example
   * // 3-instalment credit
   * { params: { CreditInstallment: "3" } }
   */
  params?: Record<string, string | number | undefined>;
}

export type EcpayCreatePaymentInput = CreatePaymentRequest & EcpayAioFields;

/**
 * ECPay's AioCheckOut is a **browser redirect**, not a settled server-side charge.
 * Auto-submit `action` + `params` so the buyer reaches the cashier; wait for
 * ReturnURL notify ({@link EcpayProvider.verifyPaymentNotify}) or query later.
 *
 * `mode: "redirect"` is explicit so callers never treat this as "payment succeeded".
 */
export interface EcpayCheckoutForm {
  mode: "redirect";
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
  createPayment(input: EcpayCreatePaymentInput): Promise<EcpayCheckoutForm>;
  refundPayment(input: RefundPaymentRequest): Promise<EcpayRefundResult>;
  /**
   * Verify a ReturnURL / OrderResultURL payment-result POST (CheckMacValue).
   * On ReturnURL, respond with {@link import("./notify.js").ECPAY_NOTIFY_ACK}.
   */
  verifyPaymentNotify(input: EcpayNotifyInput): EcpayPaymentNotify;
  /** Low-level CreditDetail/DoAction (C/R/E/N). Credit-card only. */
  creditDoAction(input: EcpayCreditDoActionInput): Promise<EcpayCreditDoActionResult>;
  /** DoAction Action=C (關帳 / capture). */
  capturePayment(input: {
    orderId: string;
    amount?: number;
    tradeNo?: string;
  }): Promise<EcpayCreditDoActionResult>;
  /** DoAction Action=E (取消關帳). */
  cancelClose(input: {
    orderId: string;
    amount?: number;
    tradeNo?: string;
  }): Promise<EcpayCreditDoActionResult>;
  /** DoAction Action=N (放棄 — pre-close void / release auth). */
  abandonPayment(input: {
    orderId: string;
    amount?: number;
    tradeNo?: string;
  }): Promise<EcpayCreditDoActionResult>;
  /**
   * CreditDetail/QueryTrade/V2 — card lifecycle status (已授權/已關帳/…).
   * Needs {@link EcpayProviderConfig.creditCheckCode} or per-call creditCheckCode.
   * ECPay documents production-only real auth; stage may reject live calls.
   */
  queryCreditTrade(input: EcpayCreditTradeQueryInput): Promise<EcpayCreditTradeDetail>;
}

/**
 * ECPay (綠界科技) All-in-One adapter. Credentials + host live on the instance;
 * `baseUrl` (or the sandbox flag) selects the gateway origin so tests can point
 * it at an MSW mock.
 */
export function createEcpayProvider(config: EcpayProviderConfig): EcpayProvider {
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

    async createPayment(input: EcpayCreatePaymentInput): Promise<EcpayCheckoutForm> {
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
        // Extra notify fields (gwsr / CreditRefundId) needed for queryCreditTrade.
        NeedExtraPaidInfo: "Y",
      };
      if (input.returnUrl) {
        params.OrderResultURL = input.returnUrl;
        params.ClientBackURL = input.returnUrl;
      }

      // Typed optional fields override the returnUrl shorthand above when both are
      // given — the explicit field is the more specific intent.
      assign(params, {
        StoreID: input.storeId,
        ClientBackURL: input.clientBackUrl,
        ItemURL: input.itemUrl,
        Remark: input.remark,
        ChooseSubPayment: input.chooseSubPayment,
        OrderResultURL: input.orderResultUrl,
        IgnorePayment: input.ignorePayment,
        PlatformID: input.platformId,
        CustomField1: input.customField1,
        CustomField2: input.customField2,
        CustomField3: input.customField3,
        CustomField4: input.customField4,
        Language: input.language,
        PaymentInfoURL: input.paymentInfoUrl,
        ClientRedirectURL: input.clientRedirectUrl,
      });
      assign(params, sanitizeExtraParams(input.params));

      // Signed last, over the final set — including everything passed through, or the
      // MAC would not cover it and ECPay would reject the order.
      params.CheckMacValue = computeCheckMacValue(params, hashKey, hashIv);

      return {
        mode: "redirect",
        action: `${origin}/Cashier/AioCheckOut/V5`,
        method: "POST",
        params,
      };
    },

    verifyPaymentNotify(input: EcpayNotifyInput): EcpayPaymentNotify {
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      return verifyPaymentNotify(input, { merchantId, hashKey, hashIv });
    },

    async creditDoAction(input: EcpayCreditDoActionInput): Promise<EcpayCreditDoActionResult> {
      return runCreditDoAction(config, origin, queryTradeInfo, input);
    },

    async capturePayment(input) {
      return runCreditDoAction(config, origin, queryTradeInfo, { ...input, action: "C" });
    },

    async cancelClose(input) {
      return runCreditDoAction(config, origin, queryTradeInfo, { ...input, action: "E" });
    },

    async abandonPayment(input) {
      return runCreditDoAction(config, origin, queryTradeInfo, { ...input, action: "N" });
    },

    async refundPayment(input: RefundPaymentRequest): Promise<EcpayRefundResult> {
      assertSupports("ecpay", CAPABILITIES, "REFUND_PAYMENT");
      const result = await runCreditDoAction(config, origin, queryTradeInfo, {
        orderId: input.orderId,
        action: "R",
        amount: input.amount,
      });
      return {
        tradeNo: result.tradeNo,
        rtnCode: result.rtnCode,
        rtnMsg: result.rtnMsg,
        amount: result.amount,
        raw: result.raw,
      };
    },

    async queryCreditTrade(input: EcpayCreditTradeQueryInput): Promise<EcpayCreditTradeDetail> {
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      const checkCode = input.creditCheckCode ?? config.creditCheckCode;
      if (checkCode === undefined || checkCode === "") {
        throw new PaymentError(
          "AUTH",
          "ECPay queryCreditTrade 需要 creditCheckCode（廠商後台 → 信用卡授權資訊）",
          "ecpay",
        );
      }

      const params: Record<string, string> = {
        MerchantID: merchantId,
        CreditRefundId: String(input.creditRefundId),
        CreditAmount: String(Math.round(input.amount)),
        CreditCheckCode: String(checkCode),
      };
      params.CheckMacValue = computeCheckMacValue(params, hashKey, hashIv);

      const text = await postForm(
        `${origin}/CreditDetail/QueryTrade/V2`,
        params,
        "QueryCreditTrade",
      );
      return parseCreditTradeResponse(text);
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

type QueryTradeInfoFn = (merTradeNo: string) => Promise<Record<string, string>>;

async function runCreditDoAction(
  config: EcpayProviderConfig,
  origin: string,
  queryTradeInfo: QueryTradeInfoFn,
  input: EcpayCreditDoActionInput,
): Promise<EcpayCreditDoActionResult> {
  const { merchantId, hashKey, hashIv } = requireCredentials(config);
  if (!["C", "R", "E", "N"].includes(input.action)) {
    throw new PaymentError(
      "VALIDATION",
      `ECPay DoAction Action 必須是 C|R|E|N（收到 "${input.action}"）`,
      "ecpay",
    );
  }

  let tradeNo = input.tradeNo;
  let amount = input.amount;

  if (!tradeNo || amount === undefined) {
    const info = await queryTradeInfo(input.orderId);
    if (info.PaymentType && !info.PaymentType.startsWith("Credit")) {
      throw new PaymentError(
        "VALIDATION",
        `ECPay DoAction（${input.action}）僅支援信用卡`,
        "ecpay",
        { raw: info },
      );
    }
    tradeNo = tradeNo ?? info.TradeNo;
    amount = amount ?? asNumber(info.TradeAmt);
  }

  if (!tradeNo) {
    throw new PaymentError("NOT_FOUND", `ECPay 查無訂單 ${input.orderId} 的 TradeNo`, "ecpay");
  }
  if (amount === undefined) {
    throw new PaymentError("VALIDATION", "ECPay DoAction 需要金額（amount）", "ecpay");
  }

  const params: Record<string, string> = {
    MerchantID: merchantId,
    MerchantTradeNo: input.orderId,
    TradeNo: tradeNo,
    Action: input.action,
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
      `ECPay DoAction(${input.action}) 失敗: ${parsed.RtnMsg ?? rtnCode}`,
      "ecpay",
      { rawCode: rtnCode, rawMessage: parsed.RtnMsg, raw: parsed },
    );
  }
  return {
    action: input.action,
    tradeNo,
    rtnCode,
    rtnMsg: parsed.RtnMsg ?? "",
    amount: Math.round(amount),
    raw: parsed,
  };
}

function parseCreditTradeResponse(text: string): EcpayCreditTradeDetail {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new PaymentError("PROVIDER", "ECPay QueryCreditTrade 回應不是 JSON", "ecpay", {
      raw: text,
    });
  }

  const root = json as {
    RtnMsg?: string;
    RtnValue?: {
      TradeID?: string | number;
      amount?: string | number;
      clsamt?: string | number;
      authtime?: string;
      status?: string;
      close_data?: Array<Record<string, unknown>>;
    };
  };

  const msg = root.RtnMsg ?? "";
  if (msg === "error_Stop" || msg === "error_nopay" || msg === "error") {
    throw new PaymentError("PROVIDER", `ECPay QueryCreditTrade 失敗: ${msg}`, "ecpay", {
      rawCode: msg,
      raw: json,
    });
  }
  if (!root.RtnValue) {
    throw new PaymentError(
      "PROVIDER",
      `ECPay QueryCreditTrade 查詢失敗${msg ? `: ${msg}` : ""}`,
      "ecpay",
      { raw: json },
    );
  }

  const v = root.RtnValue;
  const closeData = Array.isArray(v.close_data)
    ? v.close_data.map((row) => ({
        status: row.status !== undefined ? String(row.status) : undefined,
        amount: asNumber(row.amount),
        sno: row.sno !== undefined ? String(row.sno) : undefined,
        datetime: row.datetime !== undefined ? String(row.datetime) : undefined,
      }))
    : [];

  return {
    tradeId: v.TradeID !== undefined ? String(v.TradeID) : undefined,
    amount: asNumber(v.amount),
    closedAmount: asNumber(v.clsamt),
    authTime: v.authtime,
    status: v.status,
    closeData,
    raw: json,
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

function requireCredentials(config: EcpayProviderConfig) {
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

/** Copy defined values only, so an omitted option never becomes an empty form field. */
function assign(target: Record<string, string>, source: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = value;
  }
}

/**
 * Fields this adapter derives or signs. Letting a passthrough entry win over these
 * would create two sources of truth for a value that goes into the CheckMacValue —
 * the resulting order is rejected by ECPay and the cause is invisible from the code.
 */
const RESERVED_AIO_PARAMS: ReadonlySet<string> = new Set([
  "MerchantID",
  "MerchantTradeNo",
  "MerchantTradeDate",
  "PaymentType",
  "TotalAmount",
  "ReturnURL",
  "ChoosePayment",
  "EncryptType",
  "CheckMacValue",
]);

/** Stringify passthrough values, drop `undefined`, and refuse the reserved names. */
function sanitizeExtraParams(
  extra: Record<string, string | number | undefined> | undefined,
): Record<string, string | undefined> {
  if (!extra) return {};
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (RESERVED_AIO_PARAMS.has(key)) {
      throw new PaymentError(
        "VALIDATION",
        `ECPay params.${key} 由 adapter 產生或簽章，不可覆寫` +
          (key === "CheckMacValue" ? "" : `（請改用對應的具名參數或 method）`),
        "ecpay",
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new PaymentError(
        "VALIDATION",
        `ECPay params.${key} 不是有效數值（收到 ${String(value)}）`,
        "ecpay",
      );
    }
    out[key] = String(value);
  }
  return out;
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
    case "barcode":
      return "BARCODE";
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
