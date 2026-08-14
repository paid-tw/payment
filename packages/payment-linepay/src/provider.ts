import {
  assertSupports,
  type Capability,
  PaymentError,
  type CreatePaymentRequest,
  type GetPaymentRequest,
  type NormalizedPaymentData,
  type PaymentProvider,
  type RefundPaymentRequest,
} from "@paid-tw/payment";
import { LINEPAY_PATHS, type LinepayProviderConfig, resolveLinepayOrigin } from "./config.js";
import { linepayNonce, parseLinepayJson, signLinepayRequest } from "./crypto.js";
import { linepayErrorMessage, mapLinepayErrorCode } from "./codes.js";

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "CREATE_PAYMENT",
  "GET_PAYMENT",
  "REFUND_PAYMENT",
]);

/** Currencies the v4 endpoints accept (ISO 4217). */
export const LINEPAY_CURRENCIES = ["TWD", "USD", "THB"] as const;
export type LinepayCurrency = (typeof LINEPAY_CURRENCIES)[number];

export interface LinepayProduct {
  /** Merchant product id. */
  id?: string;
  name: string;
  imageUrl?: string;
  quantity: number;
  price: number;
  originalPrice?: number;
}

/** One package per shipment/store; `amount` must equal Σ(price × quantity). */
export interface LinepayPackage {
  id: string;
  amount: number;
  /** Portion of `amount` that is a fee charged to the buyer. */
  userFee?: number;
  name?: string;
  products: LinepayProduct[];
}

/**
 * The `options` object of 付款請求, typed loosely on purpose: its sub-fields
 * vary per market and doc revision, so only the flow-changing switches are
 * named and everything else passes through verbatim.
 */
export interface LinepayRequestOptions {
  payment?: {
    /**
     * `false` requests authorization only — confirm then leaves the money on
     * hold until {@link LinepayProvider.capturePayment} (or voidAuthorization).
     */
    capture?: boolean;
    /** `PREAPPROVED` issues a regKey for merchant-initiated charges. */
    payType?: "NORMAL" | "PREAPPROVED";
    [key: string]: unknown;
  };
  display?: {
    /** Payment-screen language, e.g. `zh_TW`, `en`, `ja`. */
    locale?: string;
    /** Re-check that confirmUrl opens in the browser that started payment. */
    checkConfirmUrlBrowser?: boolean;
    [key: string]: unknown;
  };
  shipping?: {
    /** Shipping fee — counted into the total `amount`. */
    feeAmount?: number;
    [key: string]: unknown;
  };
  familyService?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LinepayCreatePaymentInput extends CreatePaymentRequest {
  /**
   * Where LINE Pay sends the buyer after authentication (orderId +
   * transactionId are appended as query params). Falls back to `returnUrl`.
   * Must be HTTPS in production.
   */
  confirmUrl?: string;
  /** Where LINE Pay sends the buyer when they bail out. Required by the API. */
  cancelUrl?: string;
  /**
   * Full 商品 breakdown. Omitted → a single package is synthesized from
   * `amount` + `itemDesc`. When provided, Σ packages.amount (+ shipping fee)
   * must equal `amount`.
   */
  packages?: LinepayPackage[];
  options?: LinepayRequestOptions;
}

export interface LinepayCreatePaymentResult {
  mode: "redirect";
  /**
   * LINE Pay 交易編號 — an int64 of up to 19 digits, kept as a **string**
   * because it exceeds Number.MAX_SAFE_INTEGER (see {@link parseLinepayJson}).
   */
  transactionId: string;
  /** Send the buyer to `web` (browser) or `app`/`universal` (LINE app). */
  paymentUrl: { web?: string; app?: string; universal?: string };
  paymentAccessToken?: string;
  raw: unknown;
}

/**
 * 退款目標: the shared orderId (resolved to a transactionId via 查詢付款明細)
 * and/or the LINE Pay transactionId directly — `tradeNo` skips the lookup.
 */
export type LinepayRefundInput = RefundPaymentRequest & { tradeNo?: string };

export interface LinepayRefundResult {
  refundTransactionId: string;
  refundTransactionDate?: string;
  raw: unknown;
}

export interface LinepayConfirmInput {
  /** From the confirmUrl redirect query, or the createPayment result. */
  transactionId: string;
  /** Must equal the requested amount (1153 otherwise). */
  amount: number;
  currency: string;
}

/** One payInfo entry — how the buyer actually paid (may be split, e.g. card + points). */
export interface LinepayPayInfo {
  method?: string;
  amount?: number;
  [key: string]: unknown;
}

export interface LinepayConfirmResult {
  transactionId: string;
  orderId?: string;
  payInfo: LinepayPayInfo[];
  raw: unknown;
}

export interface LinepayCaptureInput {
  transactionId: string;
  amount: number;
  currency: string;
}

export interface LinepayCaptureResult {
  transactionId: string;
  orderId?: string;
  payInfo: LinepayPayInfo[];
  raw: unknown;
}

export interface LinepayVoidResult {
  raw: unknown;
}

/** 查詢付款請求狀態 — where the buyer is in the authentication flow. */
export interface LinepayCheckResult {
  /** pending → ready → completed, or canceled / failed. */
  status: "pending" | "ready" | "canceled" | "failed" | "completed";
  returnCode: string;
  returnMessage?: string;
  raw: unknown;
}

/** LINE Pay narrows the shared contract to its concrete shapes (still assignable). */
export interface LinepayProvider extends PaymentProvider {
  /** 付款請求 — returns the paymentUrl; nothing is charged until confirm. */
  createPayment(input: LinepayCreatePaymentInput): Promise<LinepayCreatePaymentResult>;
  /** 查詢付款明細 — post-confirm transactions only; pending ones are 1150. */
  getPayment(input: GetPaymentRequest): Promise<NormalizedPaymentData>;
  /** 退款 — full when `amount` is omitted, partial otherwise. */
  refundPayment(input: LinepayRefundInput): Promise<LinepayRefundResult>;
  /** 付款授權 (confirm) — completes the payment after the confirmUrl redirect. */
  confirmPayment(input: LinepayConfirmInput): Promise<LinepayConfirmResult>;
  /** 請款 (capture) — only for options.payment.capture=false authorizations. */
  capturePayment(input: LinepayCaptureInput): Promise<LinepayCaptureResult>;
  /** 取消授權 (void) — only before capture; after capture use refundPayment. */
  voidAuthorization(input: { transactionId: string }): Promise<LinepayVoidResult>;
  /** 查詢付款請求狀態 — poll instead of (or besides) the confirmUrl redirect. */
  checkPaymentRequestStatus(input: { transactionId: string }): Promise<LinepayCheckResult>;
}

/**
 * LINE Pay Online API v4 adapter. Credentials + host live on the instance;
 * `baseUrl` (or the sandbox flag) selects the host so tests can point it at
 * an MSW mock.
 *
 * There is no server-to-server notify: the buyer comes back through
 * confirmUrl (front channel) and the merchant then calls
 * {@link LinepayProvider.confirmPayment} — treat *that* response (or
 * getPayment) as the source of truth, never the redirect alone.
 */
export function createLinepayProvider(config: LinepayProviderConfig): LinepayProvider {
  const origin = resolveLinepayOrigin(config);

  return {
    name: "linepay",
    capabilities: CAPABILITIES,

    async createPayment(input: LinepayCreatePaymentInput): Promise<LinepayCreatePaymentResult> {
      assertSupports("linepay", CAPABILITIES, "CREATE_PAYMENT");

      if (input.method && input.method !== "linepay") {
        throw new PaymentError(
          "VALIDATION",
          `LINE Pay adapter 僅支援 method="linepay"（收到 "${input.method}"）`,
          "linepay",
        );
      }
      const currency = assertCurrency(input.currency);
      const amount = assertAmount(input.amount, currency, "amount");
      if (!input.orderId || input.orderId.length > 100) {
        throw new PaymentError("VALIDATION", "LINE Pay orderId 需為 1-100 字", "linepay");
      }
      if (input.notifyUrl) {
        throw new PaymentError(
          "VALIDATION",
          "LINE Pay v4 沒有背景通知（NotifyURL）— 付款結果來自 confirmUrl redirect 後的 confirmPayment，或輪詢 checkPaymentRequestStatus",
          "linepay",
        );
      }
      const confirmUrl = input.confirmUrl ?? input.returnUrl;
      if (!confirmUrl || !input.cancelUrl) {
        throw new PaymentError(
          "VALIDATION",
          "LINE Pay 需要 confirmUrl（或 returnUrl）與 cancelUrl 兩個導回網址",
          "linepay",
        );
      }

      const packages = input.packages ?? [
        {
          id: "1",
          amount,
          products: [{ name: input.itemDesc ?? input.orderId, quantity: 1, price: amount }],
        },
      ];
      if (input.packages) {
        const packagesSum = input.packages.reduce((sum, pkg) => sum + pkg.amount, 0);
        const shippingFee = asNumber(input.options?.shipping?.feeAmount) ?? 0;
        if (packagesSum + shippingFee !== amount) {
          throw new PaymentError(
            "VALIDATION",
            `LINE Pay amount 需等於 packages 金額合計加運費（${packagesSum} + ${shippingFee} ≠ ${amount}）`,
            "linepay",
          );
        }
      }

      const info = assertGatewayOk(
        await callApi(
          "POST",
          LINEPAY_PATHS.request,
          {
            body: {
              amount,
              currency,
              orderId: input.orderId,
              packages,
              redirectUrls: { confirmUrl, cancelUrl: input.cancelUrl },
              ...(input.options ? { options: input.options } : {}),
            },
          },
          "request",
        ),
        "request",
      ) as LinepayRequestInfo;

      const transactionId = asString(info.transactionId);
      if (!transactionId) {
        throw new PaymentError("PROVIDER", "LINE Pay request 回應缺少 transactionId", "linepay", {
          raw: info,
        });
      }
      return {
        mode: "redirect",
        transactionId,
        paymentUrl: info.paymentUrl ?? {},
        paymentAccessToken: asString(info.paymentAccessToken),
        raw: info,
      };
    },

    async getPayment(input: GetPaymentRequest): Promise<NormalizedPaymentData> {
      assertSupports("linepay", CAPABILITIES, "GET_PAYMENT");
      const entry = await fetchDetails(input);
      return normalizeDetails(entry);
    },

    async refundPayment(input: LinepayRefundInput): Promise<LinepayRefundResult> {
      assertSupports("linepay", CAPABILITIES, "REFUND_PAYMENT");
      let transactionId = input.tradeNo;
      if (!transactionId) {
        if (!input.orderId) {
          throw new PaymentError(
            "VALIDATION",
            "LINE Pay 退款需要 orderId 或 tradeNo（LINE Pay transactionId）",
            "linepay",
          );
        }
        const entry = await fetchDetails({ merTradeNo: input.orderId });
        transactionId = asString(entry.transactionId);
        if (!transactionId) {
          throw new PaymentError("PROVIDER", "LINE Pay 查詢回應缺少 transactionId", "linepay", {
            raw: entry,
          });
        }
      }
      const info = assertGatewayOk(
        await callApi(
          "POST",
          LINEPAY_PATHS.refund(transactionId),
          { body: input.amount !== undefined ? { refundAmount: input.amount } : {} },
          "refund",
        ),
        "refund",
      ) as LinepayRefundInfo;
      const refundTransactionId = asString(info.refundTransactionId);
      if (!refundTransactionId) {
        throw new PaymentError(
          "PROVIDER",
          "LINE Pay refund 回應缺少 refundTransactionId",
          "linepay",
          { raw: info },
        );
      }
      return {
        refundTransactionId,
        refundTransactionDate: asString(info.refundTransactionDate),
        raw: info,
      };
    },

    async confirmPayment(input: LinepayConfirmInput): Promise<LinepayConfirmResult> {
      const transactionId = assertTransactionId(input.transactionId, "confirm");
      const currency = assertCurrency(input.currency);
      const amount = assertAmount(input.amount, currency, "amount");
      const body = await callApi(
        "POST",
        LINEPAY_PATHS.confirm(transactionId),
        { body: { amount, currency } },
        "confirm",
      );
      const info = assertGatewayOk(body, "confirm") as LinepayConfirmInfo;
      return {
        transactionId: asString(info.transactionId) ?? transactionId,
        orderId: asString(info.orderId),
        payInfo: info.payInfo ?? [],
        raw: info,
      };
    },

    async capturePayment(input: LinepayCaptureInput): Promise<LinepayCaptureResult> {
      const transactionId = assertTransactionId(input.transactionId, "capture");
      const currency = assertCurrency(input.currency);
      const amount = assertAmount(input.amount, currency, "amount");
      const info = assertGatewayOk(
        await callApi(
          "POST",
          LINEPAY_PATHS.capture(transactionId),
          { body: { amount, currency } },
          "capture",
        ),
        "capture",
      ) as LinepayConfirmInfo;
      return {
        transactionId: asString(info.transactionId) ?? transactionId,
        orderId: asString(info.orderId),
        payInfo: info.payInfo ?? [],
        raw: info,
      };
    },

    async voidAuthorization(input: { transactionId: string }): Promise<LinepayVoidResult> {
      const transactionId = assertTransactionId(input.transactionId, "void");
      const body = await callApi("POST", LINEPAY_PATHS.void(transactionId), { body: {} }, "void");
      assertGatewayOk(body, "void");
      return { raw: body };
    },

    async checkPaymentRequestStatus(input: {
      transactionId: string;
    }): Promise<LinepayCheckResult> {
      const transactionId = assertTransactionId(input.transactionId, "check");
      const body = await callApi("GET", LINEPAY_PATHS.check(transactionId), {}, "check");
      const returnCode = body.returnCode ?? "";
      const status = CHECK_STATUSES[returnCode];
      if (!status) {
        // Not a flow status → a real error (1150 no such request, 1104 auth…).
        assertGatewayOk(body, "check");
        throw new PaymentError("PROVIDER", "LINE Pay check 回應缺少狀態碼", "linepay", {
          raw: body,
        });
      }
      return { status, returnCode, returnMessage: body.returnMessage, raw: body };
    },
  };

  /** 查詢付款明細 by transactionId and/or orderId; returns the first entry. */
  async function fetchDetails(input: GetPaymentRequest): Promise<LinepayDetailsEntry> {
    if (!input.tradeNo && !input.merTradeNo) {
      throw new PaymentError(
        "VALIDATION",
        "LINE Pay 查詢需要 tradeNo（transactionId）或 merTradeNo（orderId）",
        "linepay",
      );
    }
    const query = new URLSearchParams();
    if (input.tradeNo) query.append("transactionId", input.tradeNo);
    if (input.merTradeNo) query.append("orderId", input.merTradeNo);
    const info = assertGatewayOk(
      await callApi("GET", LINEPAY_PATHS.details, { query }, "details"),
      "details",
    );
    const entries = Array.isArray(info) ? (info as LinepayDetailsEntry[]) : [];
    if (entries.length === 0) {
      throw new PaymentError("NOT_FOUND", "LINE Pay 查無交易（details 回傳空清單）", "linepay", {
        raw: info,
      });
    }
    return entries[0]!;
  }

  /** Sign + send one API call; normalize transport/HTTP errors; parse the body. */
  async function callApi(
    method: "GET" | "POST",
    apiPath: string,
    payload: { body?: unknown; query?: URLSearchParams },
    label: string,
  ): Promise<LinepayEnvelope> {
    const { channelId, channelSecret } = requireCredentials(config);
    const nonce = linepayNonce();
    // Byte-for-byte what goes on the wire — the MAC is computed over it.
    const message =
      method === "POST" ? JSON.stringify(payload.body ?? {}) : (payload.query?.toString() ?? "");
    const url = `${origin}${apiPath}${method === "GET" && message ? `?${message}` : ""}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-LINE-ChannelId": channelId,
          "X-LINE-Authorization-Nonce": nonce,
          "X-LINE-Authorization": signLinepayRequest(channelSecret, apiPath, message, nonce),
        },
        body: method === "POST" ? message : undefined,
      });
    } catch (err) {
      throw new PaymentError("NETWORK", `LINE Pay ${label} 連線失敗`, "linepay", { cause: err });
    }

    if (!response.ok) {
      throw new PaymentError(
        "PROVIDER",
        `LINE Pay ${label} failed: ${response.status} ${response.statusText}`,
        "linepay",
        { rawCode: String(response.status) },
      );
    }

    const text = await response.text();
    if (process.env.PAID_DEBUG === "1") {
      console.error(`[linepay] ${label} response:`, text);
    }
    try {
      return parseLinepayJson(text) as LinepayEnvelope;
    } catch {
      throw new PaymentError("PROVIDER", `LINE Pay ${label} 回應不是 JSON`, "linepay", {
        raw: text,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

type LinepayEnvelope = {
  returnCode?: string;
  returnMessage?: string;
  info?: unknown;
  [key: string]: unknown;
};

type LinepayRequestInfo = {
  transactionId?: string;
  paymentUrl?: { web?: string; app?: string; universal?: string };
  paymentAccessToken?: string;
  [key: string]: unknown;
};

type LinepayConfirmInfo = {
  transactionId?: string;
  orderId?: string;
  payInfo?: LinepayPayInfo[];
  [key: string]: unknown;
};

type LinepayRefundInfo = {
  refundTransactionId?: string;
  refundTransactionDate?: string;
  [key: string]: unknown;
};

type LinepayRefundEntry = {
  refundTransactionId?: string;
  transactionType?: string;
  refundAmount?: number;
  refundTransactionDate?: string;
  [key: string]: unknown;
};

type LinepayDetailsEntry = {
  transactionId?: string;
  transactionDate?: string;
  transactionType?: string;
  payInfo?: LinepayPayInfo[];
  productName?: string;
  currency?: string;
  orderId?: string;
  refundList?: LinepayRefundEntry[];
  [key: string]: unknown;
};

const CHECK_STATUSES: Record<string, LinepayCheckResult["status"]> = {
  "0000": "pending",
  "0110": "ready",
  "0121": "canceled",
  "0122": "failed",
  "0123": "completed",
};

function requireCredentials(config: LinepayProviderConfig) {
  const { channelId, channelSecret } = config;
  if (!channelId || !channelSecret) {
    throw new PaymentError(
      "AUTH",
      "缺少 LINE Pay 憑證（Channel ID / Channel Secret）",
      "linepay",
    );
  }
  return { channelId, channelSecret };
}

function assertCurrency(currency: string): string {
  if (!(LINEPAY_CURRENCIES as readonly string[]).includes(currency)) {
    throw new PaymentError(
      "VALIDATION",
      `LINE Pay 僅支援 ${LINEPAY_CURRENCIES.join("/")}（收到 "${currency}"）`,
      "linepay",
    );
  }
  return currency;
}

/** TWD has no minor unit — a fractional amount would silently change the charge. */
function assertAmount(amount: number, currency: string, field: string): number {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new PaymentError("VALIDATION", `LINE Pay ${field} 需為正數`, "linepay");
  }
  if (currency === "TWD" && !Number.isInteger(amount)) {
    throw new PaymentError(
      "VALIDATION",
      `LINE Pay TWD 金額需為整數（收到 ${amount}）`,
      "linepay",
    );
  }
  return amount;
}

/** Ids are int64 strings; a lost-precision number would target the wrong payment. */
function assertTransactionId(value: string, label: string): string {
  if (typeof value !== "string" || !/^\d{1,19}$/.test(value)) {
    throw new PaymentError(
      "VALIDATION",
      `LINE Pay ${label} 需要字串型別的 transactionId（int64 超出 JS number 精度，收到 ${JSON.stringify(value)}）`,
      "linepay",
    );
  }
  return value;
}

/** Throw a mapped PaymentError unless returnCode is 0000; return the info. */
function assertGatewayOk(body: LinepayEnvelope, label: string): unknown {
  const code = body.returnCode ?? "";
  if (code === "0000") return body.info ?? {};
  const rawMessage = body.returnMessage;
  throw new PaymentError(
    mapLinepayErrorCode(code),
    `LINE Pay ${label} 失敗 ${code}: ${linepayErrorMessage(code, rawMessage)}`,
    "linepay",
    { rawCode: code, rawMessage, raw: body },
  );
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeDetails(entry: LinepayDetailsEntry): NormalizedPaymentData {
  const paid = (entry.payInfo ?? []).reduce((sum, p) => sum + (asNumber(p.amount) ?? 0), 0);
  const refunds = entry.refundList ?? [];
  // refundAmount is recorded negative in details responses; use magnitudes.
  const refunded = refunds.reduce((sum, r) => sum + Math.abs(asNumber(r.refundAmount) ?? 0), 0);
  return {
    status: refunds.length === 0 ? "paid" : refunded >= paid ? "refunded" : "partially_refunded",
    method: "linepay",
    amount: paid || undefined,
    paidAt: asString(entry.transactionDate),
    tradeNo: asString(entry.transactionId),
    merTradeNo: asString(entry.orderId),
    raw: entry,
  };
}

function asString(input: unknown): string | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  return String(input);
}

function asNumber(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const num = Number(input);
  return Number.isNaN(num) ? undefined : num;
}
