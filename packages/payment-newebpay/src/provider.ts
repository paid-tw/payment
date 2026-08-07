import {
  assertSupports,
  type Capability,
  PaymentError,
  type CreatePaymentRequest,
  type GetPaymentRequest,
  type NormalizedPaymentData,
  type PaymentMethod,
  type PaymentProvider,
  type RefundPaymentRequest,
} from "@paid-tw/payment";
import { NEWEBPAY_PATHS, type NewebpayProviderConfig, resolveNewebpayOrigin } from "./config.js";
import { buildQuery, checkCode, checkValue, encryptTradeInfo, tradeSha } from "./crypto.js";
import { mapNewebpayErrorCode, newebpayErrorMessage } from "./codes.js";
import {
  type NewebpayNotifyCredentials,
  type NewebpayNotifyInput,
  type NewebpayGetCodeNotify,
  type NewebpayPaymentNotify,
  mapNewebpayPaymentType,
  verifyNewebpayGetCodeNotify,
  verifyNewebpayPaymentNotify,
} from "./notify.js";

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "CREATE_PAYMENT",
  "GET_PAYMENT",
  "REFUND_PAYMENT",
]);

/** MPG 交易 Version (NDNF-1.2.3; 1.1.9 bumped it to 2.3). */
export const NEWEBPAY_MPG_VERSION = "2.3";

/**
 * NewebPay's MPG checkout is a **front-channel browser form post** — iframe,
 * proxy, or server-side POST is rejected with MPG02005. Auto-submit `action` +
 * `params` so the buyer reaches the hosted page; wait for the NotifyURL notify
 * ({@link NewebpayProvider.verifyPaymentNotify}) or query later.
 */
export interface NewebpayCheckoutForm {
  mode: "redirect";
  action: string;
  method: "POST";
  params: {
    MerchantID: string;
    TradeInfo: string;
    TradeSha: string;
    Version: string;
  };
}

/**
 * The MPG optional fields worth typing. Everything else (WEBATM, TWQR, wallet
 * flags, InstFlag, OrderDetail, CVSCOM/logistics, NTCB, TokenTerm, …) goes
 * through {@link NewebpayMpgFields.params} verbatim — there are 40+ of them,
 * they change per manual revision, and enumerating them here would mean a
 * release every time NewebPay adds one.
 */
export interface NewebpayMpgFields {
  /** MPG page language: `en` / `zh-tw` / `jp`. Default zh-tw. */
  langType?: string;
  /** Payment window in seconds, 60–900. */
  tradeLimit?: number;
  /** Non-instant payment code expiry, `Ymd` (e.g. `20260830`), max 180 days out. */
  expireDate?: string;
  /** CVS-code / KGI-ATM expiry time, `His` (e.g. `235959`). */
  expireTime?: string;
  /** Front-channel form POST target for the 取號 (get-code) result — ATM/CVS/barcode. */
  customerUrl?: string;
  /** URL for the "return to shop" button on the MPG/result pages. */
  clientBackUrl?: string;
  /** Payer email, notified on completion/get-code. */
  email?: string;
  /** 1 = payer may edit the email on the MPG page (default), 0 = locked. */
  emailModify?: 0 | 1;
  /** Shown on the MPG page. */
  orderComment?: string;
  /**
   * Escape hatch for any other TradeInfo field, merged verbatim before
   * encryption — so method-specific parameters work without this adapter
   * having to know about them (e.g. `{ WEBATM: 1 }`, `{ InstFlag: "3,6" }`).
   *
   * Names the adapter derives or signs are rejected rather than silently
   * overridden; names with a typed option above are rejected in favour of the
   * typed field. `EncryptType` is rejected because AES-GCM (EncryptType=1) has
   * no published spec/vectors to implement against.
   */
  params?: Record<string, string | number | undefined>;
}

export type NewebpayCreatePaymentInput = CreatePaymentRequest & NewebpayMpgFields;

/**
 * QueryTradeInfo needs the order **amount** — its CheckValue signs
 * `Amt + MerchantID + MerchantOrderNo`, and there is no TradeNo-based lookup.
 */
export interface NewebpayGetPaymentInput extends GetPaymentRequest {
  merTradeNo?: string;
  /** The exact order amount (TWD) used at create time. */
  amount: number;
}

/** Close/Cancel target: the merchant order id and/or the NewebPay TradeNo. */
export interface NewebpayCreditActionInput {
  orderId?: string;
  /** NewebPay 交易序號; when given it is used as the index (IndexType 2). */
  tradeNo?: string;
  /** Exact amount (TWD). Capture/refund of 分期/紅利 must be the full amount. */
  amount: number;
}

export interface NewebpayCreditActionResult {
  tradeNo?: string;
  merTradeNo?: string;
  amount?: number;
  /** Gateway Status, e.g. `SUCCESS` (or `TRA20001` for a queued cancel-auth). */
  status: string;
  message: string;
  raw: unknown;
}

export interface NewebpayCancelAuthorizationResult extends NewebpayCreditActionResult {
  /** `true` when the gateway answered TRA20001 — cancel queued for the bank batch. */
  queued: boolean;
}

export type NewebpayRefundInput = RefundPaymentRequest & { tradeNo?: string };

/** NewebPay narrows the shared contract to its concrete shapes (still assignable). */
export interface NewebpayProvider extends PaymentProvider {
  createPayment(input: NewebpayCreatePaymentInput): Promise<NewebpayCheckoutForm>;
  getPayment(input: NewebpayGetPaymentInput): Promise<NormalizedPaymentData>;
  /** CreditCard/Close CloseType=2 (退款). Credit-card family only. */
  refundPayment(input: NewebpayRefundInput): Promise<NewebpayCreditActionResult>;
  /** CreditCard/Close CloseType=1 (請款 / capture). */
  capturePayment(input: NewebpayCreditActionInput): Promise<NewebpayCreditActionResult>;
  /** CreditCard/Close CloseType=1 + Cancel=1 (取消請款). */
  cancelCapture(input: NewebpayCreditActionInput): Promise<NewebpayCreditActionResult>;
  /** CreditCard/Close CloseType=2 + Cancel=1 (取消退款). */
  cancelRefund(input: NewebpayCreditActionInput): Promise<NewebpayCreditActionResult>;
  /** CreditCard/Cancel (取消授權) — only before capture; TRA20001 = queued. */
  cancelAuthorization(input: NewebpayCreditActionInput): Promise<NewebpayCancelAuthorizationResult>;
  /** Verify a NotifyURL / ReturnURL payment-result POST (TradeSha + AES). */
  verifyPaymentNotify(input: NewebpayNotifyInput): NewebpayPaymentNotify;
  /** Verify a CustomerURL 取號 (get-code) POST — ATM/CVS/barcode/CVSCOM. */
  verifyGetCodeNotify(input: NewebpayNotifyInput): NewebpayGetCodeNotify;
}

/**
 * NewebPay (藍新金流) MPG adapter. Credentials + host live on the instance;
 * `baseUrl` (or the sandbox flag) selects ccore vs core so tests can point it
 * at an MSW mock.
 */
export function createNewebpayProvider(config: NewebpayProviderConfig): NewebpayProvider {
  const origin = resolveNewebpayOrigin(config);

  return {
    name: "newebpay",
    capabilities: CAPABILITIES,

    async createPayment(input: NewebpayCreatePaymentInput): Promise<NewebpayCheckoutForm> {
      assertSupports("newebpay", CAPABILITIES, "CREATE_PAYMENT");
      const { merchantId, hashKey, hashIv } = requireCredentials(config);

      if (input.currency && input.currency !== "TWD") {
        throw new PaymentError("VALIDATION", "NewebPay MPG 僅支援 TWD", "newebpay");
      }
      if (!input.notifyUrl) {
        throw new PaymentError(
          "VALIDATION",
          "NewebPay 需要 notify-url 作為 NotifyURL（背景付款結果通知）",
          "newebpay",
        );
      }
      if (input.returnUrl && input.returnUrl === input.notifyUrl) {
        throw new PaymentError(
          "VALIDATION",
          "NewebPay 的 ReturnURL 與 NotifyURL 不可為同一網址（官方文件禁止，會造成重複入帳）",
          "newebpay",
        );
      }
      if (!/^[A-Za-z0-9_]{1,30}$/.test(input.orderId)) {
        throw new PaymentError(
          "VALIDATION",
          `NewebPay MerchantOrderNo 需為 1-30 碼英數字或底線（收到 "${input.orderId}"）`,
          "newebpay",
        );
      }
      const amount = Math.round(input.amount);
      assertAmountGate(input.method, amount);
      const itemDesc = input.itemDesc ?? input.orderId;
      if (Array.from(itemDesc).length > 50) {
        throw new PaymentError("VALIDATION", "NewebPay ItemDesc 上限 50 字", "newebpay");
      }

      // Field order mirrors the manual's sample; the gateway parses a query
      // string so order is not semantic, but determinism keeps fixtures stable.
      const fields: Record<string, string | number | undefined> = {
        MerchantID: merchantId,
        RespondType: "JSON",
        TimeStamp: epochSeconds(),
        Version: NEWEBPAY_MPG_VERSION,
        MerchantOrderNo: input.orderId,
        Amt: amount,
        ItemDesc: itemDesc,
        NotifyURL: input.notifyUrl,
        ReturnURL: input.returnUrl,
        CustomerURL: input.customerUrl,
        ClientBackURL: input.clientBackUrl,
        LangType: input.langType,
        TradeLimit: input.tradeLimit,
        ExpireDate: input.expireDate,
        ExpireTime: input.expireTime,
        Email: input.email,
        EmailModify: input.emailModify,
        OrderComment: input.orderComment,
        [methodFlag(input.method)]: 1,
      };
      Object.assign(fields, sanitizeExtraParams(input.params, input.method));

      const tradeInfo = encryptTradeInfo(buildQuery(fields), hashKey, hashIv);
      return {
        mode: "redirect",
        action: `${origin}${NEWEBPAY_PATHS.mpg}`,
        method: "POST",
        params: {
          MerchantID: merchantId,
          TradeInfo: tradeInfo,
          TradeSha: tradeSha(tradeInfo, hashKey, hashIv),
          Version: NEWEBPAY_MPG_VERSION,
        },
      };
    },

    async getPayment(input: NewebpayGetPaymentInput): Promise<NormalizedPaymentData> {
      assertSupports("newebpay", CAPABILITIES, "GET_PAYMENT");
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      if (!input.merTradeNo) {
        throw new PaymentError(
          "VALIDATION",
          "NewebPay 查詢需要 MerchantOrderNo（查詢 API 不支援以 TradeNo 查詢）",
          "newebpay",
        );
      }
      if (typeof input.amount !== "number" || !Number.isFinite(input.amount)) {
        throw new PaymentError(
          "VALIDATION",
          "NewebPay 查詢需要訂單金額 amount（CheckValue 以 Amt 簽章）",
          "newebpay",
        );
      }
      const amount = Math.round(input.amount);

      const params: Record<string, string> = {
        MerchantID: merchantId,
        Version: "1.3",
        RespondType: "JSON",
        CheckValue: checkValue(
          { Amt: amount, MerchantID: merchantId, MerchantOrderNo: input.merTradeNo },
          hashKey,
          hashIv,
        ),
        TimeStamp: epochSeconds(),
        MerchantOrderNo: input.merTradeNo,
        Amt: String(amount),
      };
      // Composite shops (代號 MS5 開頭) must query through the Composite gateway.
      if (merchantId.startsWith("MS5")) params.Gateway = "Composite";

      const body = await postForm(
        `${origin}${NEWEBPAY_PATHS.queryTradeInfo}`,
        params,
        "QueryTradeInfo",
      );
      const result = assertGatewayOk(body, "QueryTradeInfo") as NewebpayQueryResult;

      const expected = checkCode(
        {
          Amt: String(result.Amt ?? ""),
          MerchantID: String(result.MerchantID ?? ""),
          MerchantOrderNo: String(result.MerchantOrderNo ?? ""),
          TradeNo: String(result.TradeNo ?? ""),
        },
        hashKey,
        hashIv,
      );
      if (result.CheckCode !== expected) {
        throw new PaymentError("AUTH", "NewebPay 查詢回應 CheckCode 驗證失敗", "newebpay", {
          raw: body,
        });
      }
      return normalizeQueryResult(result);
    },

    async refundPayment(input: NewebpayRefundInput): Promise<NewebpayCreditActionResult> {
      assertSupports("newebpay", CAPABILITIES, "REFUND_PAYMENT");
      if (input.amount === undefined) {
        throw new PaymentError(
          "VALIDATION",
          "NewebPay 退款需要金額 amount（分期/紅利交易必須全額退款）",
          "newebpay",
        );
      }
      return creditClose(
        { orderId: input.orderId, tradeNo: input.tradeNo, amount: input.amount },
        { closeType: 2 },
      );
    },

    async capturePayment(input) {
      return creditClose(input, { closeType: 1 });
    },

    async cancelCapture(input) {
      return creditClose(input, { closeType: 1, cancel: true });
    },

    async cancelRefund(input) {
      return creditClose(input, { closeType: 2, cancel: true });
    },

    async cancelAuthorization(
      input: NewebpayCreditActionInput,
    ): Promise<NewebpayCancelAuthorizationResult> {
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      const index = resolveIndex(input);
      if (typeof input.amount !== "number" || !Number.isFinite(input.amount)) {
        throw new PaymentError(
          "VALIDATION",
          "NewebPay 取消授權需要金額 amount（需與授權金額相同）",
          "newebpay",
        );
      }
      const inner: Record<string, string | number | undefined> = {
        RespondType: "JSON",
        Version: "1.0",
        Amt: Math.round(input.amount),
        MerchantOrderNo: index.merTradeNo,
        TradeNo: index.tradeNo,
        IndexType: index.indexType,
        TimeStamp: epochSeconds(),
      };
      const body = await postForm(
        `${origin}${NEWEBPAY_PATHS.creditCancel}`,
        {
          MerchantID_: merchantId,
          PostData_: encryptTradeInfo(buildQuery(inner), hashKey, hashIv),
        },
        "CreditCard/Cancel",
      );

      // TRA20001 = cancel accepted, queued for the nightly bank batch.
      const queued = body.Status === "TRA20001";
      const result = queued
        ? ((body.Result ?? {}) as NewebpayCloseResult)
        : (assertGatewayOk(body, "CreditCard/Cancel") as NewebpayCloseResult);

      if (result.CheckCode !== undefined) {
        const expected = checkCode(
          {
            Amt: String(result.Amt ?? ""),
            MerchantID: String(result.MerchantID ?? ""),
            MerchantOrderNo: String(result.MerchantOrderNo ?? ""),
            TradeNo: String(result.TradeNo ?? ""),
          },
          hashKey,
          hashIv,
        );
        if (result.CheckCode !== expected) {
          throw new PaymentError("AUTH", "NewebPay 取消授權回應 CheckCode 驗證失敗", "newebpay", {
            raw: body,
          });
        }
      }
      return { ...toActionResult(body, result), queued };
    },

    verifyPaymentNotify(input: NewebpayNotifyInput): NewebpayPaymentNotify {
      return verifyNewebpayPaymentNotify(input, notifyCredentials(config));
    },

    verifyGetCodeNotify(input: NewebpayNotifyInput): NewebpayGetCodeNotify {
      return verifyNewebpayGetCodeNotify(input, notifyCredentials(config));
    },
  };

  /** CreditCard/Close — one endpoint, four functions via CloseType/Cancel. */
  async function creditClose(
    input: NewebpayCreditActionInput,
    options: { closeType: 1 | 2; cancel?: boolean },
  ): Promise<NewebpayCreditActionResult> {
    const { merchantId, hashKey, hashIv } = requireCredentials(config);
    const index = resolveIndex(input);
    if (typeof input.amount !== "number" || !Number.isFinite(input.amount)) {
      throw new PaymentError("VALIDATION", "NewebPay 請退款需要金額 amount", "newebpay");
    }
    const inner: Record<string, string | number | undefined> = {
      RespondType: "JSON",
      Version: "1.1",
      Amt: Math.round(input.amount),
      MerchantOrderNo: index.merTradeNo,
      TradeNo: index.tradeNo,
      TimeStamp: epochSeconds(),
      IndexType: index.indexType,
      CloseType: options.closeType,
      Cancel: options.cancel ? 1 : undefined,
    };
    const body = await postForm(
      `${origin}${NEWEBPAY_PATHS.creditClose}`,
      {
        MerchantID_: merchantId,
        PostData_: encryptTradeInfo(buildQuery(inner), hashKey, hashIv),
      },
      "CreditCard/Close",
    );
    const result = assertGatewayOk(body, "CreditCard/Close") as NewebpayCloseResult;
    return toActionResult(body, result);
  }

  function notifyCredentials(cfg: NewebpayProviderConfig): NewebpayNotifyCredentials {
    const { merchantId, hashKey, hashIv } = requireCredentials(cfg);
    return { merchantId, hashKey, hashIv };
  }
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

type NewebpayEnvelope = {
  Status?: string;
  Message?: string;
  Result?: unknown;
  [key: string]: unknown;
};

type NewebpayQueryResult = {
  MerchantID?: string;
  Amt?: string | number;
  TradeNo?: string;
  MerchantOrderNo?: string;
  TradeStatus?: string | number;
  OrderStatus?: string | number;
  PaymentType?: string;
  CreateTime?: string;
  PayTime?: string;
  CheckCode?: string;
  [key: string]: unknown;
};

type NewebpayCloseResult = {
  MerchantID?: string;
  Amt?: string | number;
  TradeNo?: string;
  MerchantOrderNo?: string;
  CheckCode?: string;
  [key: string]: unknown;
};

function requireCredentials(config: NewebpayProviderConfig) {
  const { merchantId, hashKey, hashIv } = config;
  if (!merchantId || !hashKey || !hashIv) {
    throw new PaymentError(
      "AUTH",
      "缺少 NewebPay 憑證（MerchantID / HashKey / HashIV）",
      "newebpay",
    );
  }
  return { merchantId, hashKey, hashIv };
}

function epochSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

/** POST form-urlencoded; normalize transport/HTTP errors; parse the JSON body. */
async function postForm(
  url: string,
  params: Record<string, string>,
  label: string,
): Promise<NewebpayEnvelope> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  } catch (err) {
    throw new PaymentError("NETWORK", `NewebPay ${label} 連線失敗`, "newebpay", { cause: err });
  }

  if (!response.ok) {
    throw new PaymentError(
      "PROVIDER",
      `NewebPay ${label} failed: ${response.status} ${response.statusText}`,
      "newebpay",
      { rawCode: String(response.status) },
    );
  }

  const text = await response.text();
  if (process.env.PAID_DEBUG === "1") {
    console.error(`[newebpay] ${label} response:`, text);
  }
  try {
    return JSON.parse(text) as NewebpayEnvelope;
  } catch {
    throw new PaymentError("PROVIDER", `NewebPay ${label} 回應不是 JSON`, "newebpay", {
      raw: text,
    });
  }
}

/** Throw a mapped PaymentError unless Status is SUCCESS; return the Result. */
function assertGatewayOk(body: NewebpayEnvelope, label: string): unknown {
  const status = body.Status ?? "";
  if (status === "SUCCESS") return body.Result ?? {};
  const rawMessage = body.Message;
  throw new PaymentError(
    mapNewebpayErrorCode(status),
    `NewebPay ${label} 失敗 ${status}: ${newebpayErrorMessage(status, rawMessage)}`,
    "newebpay",
    { rawCode: status, rawMessage, raw: body },
  );
}

function toActionResult(
  body: NewebpayEnvelope,
  result: NewebpayCloseResult,
): NewebpayCreditActionResult {
  return {
    tradeNo: result.TradeNo !== undefined ? String(result.TradeNo) : undefined,
    merTradeNo: result.MerchantOrderNo !== undefined ? String(result.MerchantOrderNo) : undefined,
    amount: asNumber(result.Amt),
    status: body.Status ?? "",
    message: body.Message ?? "",
    raw: body,
  };
}

function resolveIndex(input: NewebpayCreditActionInput): {
  merTradeNo?: string;
  tradeNo?: string;
  indexType: 1 | 2;
} {
  if (input.tradeNo) return { merTradeNo: input.orderId, tradeNo: input.tradeNo, indexType: 2 };
  if (input.orderId) return { merTradeNo: input.orderId, indexType: 1 };
  throw new PaymentError(
    "VALIDATION",
    "NewebPay 信用卡操作需要 orderId（MerchantOrderNo）或 tradeNo",
    "newebpay",
  );
}

/** MPG enable flag for a shared PaymentMethod. */
function methodFlag(method: PaymentMethod): string {
  switch (method) {
    case "card":
      return "CREDIT";
    case "atm":
      return "VACC";
    case "cvs":
      return "CVS";
    case "barcode":
      return "BARCODE";
    case "linepay":
      return "LINEPAY";
  }
}

/**
 * Per-method amount gates from the manual — outside these the MPG page hides
 * the method entirely, leaving the consumer with no way to pay, so failing
 * fast locally beats a silently unpayable order.
 */
function assertAmountGate(method: PaymentMethod, amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PaymentError("VALIDATION", "NewebPay Amt 需為正整數（TWD）", "newebpay");
  }
  const gates: Partial<Record<PaymentMethod, [number, number]>> = {
    atm: [1, 49_999],
    cvs: [30, 20_000],
    barcode: [20, 40_000],
  };
  const gate = gates[method];
  if (gate && (amount < gate[0] || amount > gate[1])) {
    throw new PaymentError(
      "VALIDATION",
      `NewebPay ${methodFlag(method)} 金額限制 ${gate[0]}–${gate[1]} 元（收到 ${amount}）`,
      "newebpay",
    );
  }
}

/** Fields this adapter derives or signs, mapped to how a caller influences them. */
const RESERVED_MPG_PARAMS: ReadonlyMap<string, string | null> = new Map([
  ["MerchantID", "provider config (merchantId)"],
  ["RespondType", null],
  ["TimeStamp", null],
  ["Version", null],
  ["MerchantOrderNo", "orderId"],
  ["Amt", "amount"],
  ["ItemDesc", "itemDesc"],
  ["NotifyURL", "notifyUrl"],
  ["ReturnURL", "returnUrl"],
  // AES-GCM (EncryptType=1) has no published parameters or test vectors.
  ["EncryptType", null],
]);

/** MPG parameters that already have a typed option. */
const TYPED_MPG_PARAMS: ReadonlyMap<string, string> = new Map([
  ["LangType", "langType"],
  ["TradeLimit", "tradeLimit"],
  ["ExpireDate", "expireDate"],
  ["ExpireTime", "expireTime"],
  ["CustomerURL", "customerUrl"],
  ["ClientBackURL", "clientBackUrl"],
  ["Email", "email"],
  ["EmailModify", "emailModify"],
  ["OrderComment", "orderComment"],
]);

const MPG_PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const OBJECT_INTERNAL_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Stringify passthrough values, drop `undefined`, refuse names we own. */
function sanitizeExtraParams(
  extra: Record<string, string | number | undefined> | undefined,
  method: PaymentMethod,
): Record<string, string | number> {
  if (!extra) return {};
  const out: Record<string, string | number> = Object.create(null) as Record<
    string,
    string | number
  >;
  const chosenFlag = methodFlag(method);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (OBJECT_INTERNAL_NAMES.has(key) || !MPG_PARAM_NAME.test(key)) {
      throw new PaymentError(
        "VALIDATION",
        `NewebPay params 的欄位名稱需為英數字與底線且以字母開頭（收到 "${key}"）`,
        "newebpay",
      );
    }
    if (key === chosenFlag) {
      throw new PaymentError(
        "VALIDATION",
        `NewebPay params.${key} 已由 method="${method}" 啟用，不可重複設定`,
        "newebpay",
      );
    }
    if (RESERVED_MPG_PARAMS.has(key)) {
      const alternative = RESERVED_MPG_PARAMS.get(key) ?? null;
      throw new PaymentError(
        "VALIDATION",
        `NewebPay params.${key} 由 adapter 產生或簽章，不可覆寫` +
          (alternative ? `（請改用 ${alternative}）` : ""),
        "newebpay",
      );
    }
    const typed = TYPED_MPG_PARAMS.get(key);
    if (typed) {
      throw new PaymentError(
        "VALIDATION",
        `NewebPay params.${key} 已有具名參數，請改用 ${typed}（避免兩處設定同一欄位）`,
        "newebpay",
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new PaymentError(
        "VALIDATION",
        `NewebPay params.${key} 不是有效數值（收到 ${String(value)}）`,
        "newebpay",
      );
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeQueryResult(result: NewebpayQueryResult): NormalizedPaymentData {
  return {
    status: mapTradeStatus(asString(result.TradeStatus), asString(result.OrderStatus)),
    method: mapNewebpayPaymentType(result.PaymentType),
    amount: asNumber(result.Amt),
    paidAt: asDateTime(result.PayTime),
    tradeNo: asString(result.TradeNo),
    merTradeNo: asString(result.MerchantOrderNo),
    raw: result,
  };
}

/**
 * QueryTradeInfo TradeStatus: 0 未付款, 1 付款成功, 2 付款失敗, 3 取消, 6 退款.
 * OrderStatus (Version ≥ 1.3) adds 9 = 付款中-待銀行確認.
 */
function mapTradeStatus(trade?: string, order?: string): string {
  if (order === "9") return "pending";
  switch (trade) {
    case "0":
      return "unpaid";
    case "1":
      return "paid";
    case "2":
      return "failed";
    case "3":
      return "canceled";
    case "6":
      return "refunded";
    default:
      return trade ?? "unknown";
  }
}

function asString(input: unknown): string | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  return String(input);
}

/** Blank and zero-dates ("0000-00-00…") both mean "not paid yet". */
function asDateTime(input: unknown): string | undefined {
  const value = asString(input);
  if (!value || value.startsWith("0000-00-00")) return undefined;
  return value;
}

function asNumber(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const num = Number(input);
  return Number.isNaN(num) ? undefined : num;
}
