import {
  assertSupports,
  type Capability,
  type CreatePaymentRequest,
  PaymentError,
  type NormalizedPaymentData,
  type PaymentProvider,
} from "@paid-tw/payment";
import { NEWEBPAY_PATHS, type NewebpayProviderConfig, resolveNewebpayOrigin } from "../config.js";
import { buildQuery, encryptTradeInfo } from "../crypto.js";
import { mapNewebpayErrorCode, newebpayErrorMessage } from "../codes.js";
import type { NewebpayNotifyInput } from "../notify.js";
import {
  decryptPeriodEnvelope,
  type NewebpayPeriodCreateNotify,
  type NewebpayPeriodCycleNotify,
  verifyPeriodCreateNotify,
  verifyPeriodCycleNotify,
} from "./notify.js";

/**
 * 信用卡定期定額 (NDNP-1.0.7). Only mandate creation moves money through this
 * line, so CREATE_PAYMENT is the sole shared capability — there is no query
 * API (GET_PAYMENT), and refunds of individual period charges go through the
 * MPG provider's CreditCard/Close using the per-period TradeNo from
 * {@link NewebpayPeriodCycleNotify.tradeNo}.
 */
const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(["CREATE_PAYMENT"]);

/** Endpoint versions fragment per API — create 1.5, AlterStatus 1.0, AlterAmt 1.2. */
export const NEWEBPAY_PERIOD_VERSIONS = {
  create: "1.5",
  alterStatus: "1.0",
  alterAmt: "1.2",
} as const;

export type NewebpayPeriodType = "D" | "W" | "M" | "Y";
export type NewebpayPeriodAlterType = "suspend" | "terminate" | "restart";

/**
 * Shares the contract's create shape: `orderId` → MerOrderNo, `amount` →
 * PeriodAmt (the PER-period charge), `itemDesc`/`prodDesc` → ProdDesc,
 * `notifyUrl`/`returnUrl` → the mandate URLs. `method` must be `"card"` —
 * the periodic line only charges credit cards.
 */
export interface NewebpayPeriodCreateInput extends CreatePaymentRequest {
  /** ProdDesc — Chinese/English/digits/spaces/underscore only. Falls back to itemDesc. */
  prodDesc?: string;
  /** D = every N days, W = weekly, M = monthly, Y = yearly. */
  periodType: NewebpayPeriodType;
  /**
   * When in the period to charge: D → `2`–`999` (days), W → `1`–`7`
   * (Mon–Sun), M → `01`–`31` (day of month), Y → `MMDD`.
   */
  periodPoint: string;
  /** Total charges. 1–99, or `"NE"` (unlimited — CAU merchants only). */
  periodTimes: number | "NE";
  /**
   * PeriodStartType: 1 = auth NT$10 now and void it (card check);
   * 2 = charge P1 (PeriodAmt) immediately; 3 = no card check now — the
   * mandate is created and P1 runs on schedule (a failed P1 terminates it).
   */
  startType: 1 | 2 | 3;
  /** PayerEmail — required by the gateway. */
  payerEmail: string;
  /** PeriodFirstdate `YYYY/mm/dd` — ONLY valid when periodType "D" + startType 3. */
  firstDate?: string;
  /** Where the consumer lands when cancelling on the hosted page. */
  backUrl?: string;
  /** PeriodMemo. */
  memo?: string;
  /** `en` / `zh-Tw`. */
  langType?: string;
  /** 1 = payer may edit the email (default), 0 = locked. */
  emailModify?: 0 | 1;
  /** Show payer-info fields on the hosted page. Default Y. */
  paymentInfo?: "Y" | "N";
  /** Show recipient-info fields on the hosted page. Default Y. */
  orderInfo?: "Y" | "N";
}

/** The hosted 定期定額 card page is entered by browser form post, like MPG. */
export interface NewebpayPeriodCheckoutForm {
  mode: "redirect";
  action: string;
  method: "POST";
  params: { MerchantID_: string; PostData_: string };
}

export interface NewebpayPeriodAlterStatusInput {
  /** MerOrderNo of the mandate. */
  orderId: string;
  /** PeriodNo (`P…`) from the create result. */
  periodNo: string;
  /**
   * `suspend` / `terminate` / `restart` (lowercase). Terminate is permanent;
   * restart resumes at the nearest upcoming period and extends the schedule
   * tail (total periods unchanged).
   */
  alterType: NewebpayPeriodAlterType;
}

export interface NewebpayPeriodAlterStatusResult {
  status: string;
  message: string;
  merOrderNo?: string;
  periodNo?: string;
  alterType?: string;
  /** Next auth date of a re-enabled mandate. */
  newNextTime?: string;
  raw: unknown;
}

export interface NewebpayPeriodAlterAmtInput {
  orderId: string;
  periodNo: string;
  /** New per-period amount (AlterAmt). */
  amount?: number;
  /**
   * New cycle for not-yet-authorized periods. The gateway requires
   * periodType and periodPoint TOGETHER when either is given.
   */
  periodType?: NewebpayPeriodType;
  periodPoint?: string;
  /** New TOTAL period count; required when changing cardExpiry; clamped to card expiry. */
  periodTimes?: number;
  /** Extday — new card expiry, `YYMM` (e.g. May 2031 → `3105`). */
  cardExpiry?: string;
  /** New per-period NotifyURL; omit to leave unchanged. */
  notifyUrl?: string;
}

export interface NewebpayPeriodAlterAmtResult {
  status: string;
  message: string;
  merOrderNo?: string;
  periodNo?: string;
  amount?: number;
  periodType?: string;
  periodPoint?: string;
  newNextAmt?: number;
  newNextTime?: string;
  periodTimes?: number;
  /** The response spells it `ExtDay` (request field is `Extday`). */
  cardExpiry?: string;
  /** `"-"` means "not modified this time". */
  notifyUrl?: string;
  raw: unknown;
}

export interface NewebpayPeriodProvider extends PaymentProvider {
  createPayment(input: NewebpayPeriodCreateInput): Promise<NewebpayPeriodCheckoutForm>;
  /** 修改委託狀態 [NPA-B051] — suspend / terminate / restart. */
  alterStatus(input: NewebpayPeriodAlterStatusInput): Promise<NewebpayPeriodAlterStatusResult>;
  /** 修改委託內容 [NPA-B052] — amount / cycle / expiry / total periods / NotifyURL. */
  alterAmount(input: NewebpayPeriodAlterAmtInput): Promise<NewebpayPeriodAlterAmtResult>;
  /** Verify a mandate-creation result (ReturnURL / NotifyURL). */
  verifyPeriodCreateNotify(input: NewebpayNotifyInput): NewebpayPeriodCreateNotify;
  /** Verify an each-period result [NPA-N050]. */
  verifyPeriodCycleNotify(input: NewebpayNotifyInput): NewebpayPeriodCycleNotify;
}

/**
 * NewebPay 信用卡定期定額 adapter — separate factory (`name: "newebpay-period"`)
 * because the periodic line has its own endpoints, envelope (`MerchantID_` +
 * `PostData_`, no TradeSha), response shapes, and error table, while sharing
 * the merchant credentials and AES primitive with MPG.
 */
export function createNewebpayPeriodProvider(
  config: NewebpayProviderConfig,
): NewebpayPeriodProvider {
  const origin = resolveNewebpayOrigin(config);

  return {
    name: "newebpay-period",
    capabilities: CAPABILITIES,

    async createPayment(input: NewebpayPeriodCreateInput): Promise<NewebpayPeriodCheckoutForm> {
      assertSupports("newebpay-period", CAPABILITIES, "CREATE_PAYMENT");
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      validateCreateInput(input);

      // Field order mirrors the manual's worked example.
      const fields: Record<string, string | number | undefined> = {
        RespondType: "JSON",
        TimeStamp: epochSeconds(),
        Version: NEWEBPAY_PERIOD_VERSIONS.create,
        LangType: input.langType,
        MerOrderNo: input.orderId,
        ProdDesc: input.prodDesc ?? input.itemDesc,
        PeriodAmt: Math.round(input.amount),
        PeriodType: input.periodType,
        PeriodPoint: input.periodPoint,
        PeriodStartType: input.startType,
        PeriodTimes: input.periodTimes,
        PeriodFirstdate: input.firstDate,
        PayerEmail: input.payerEmail,
        PaymentInfo: input.paymentInfo,
        OrderInfo: input.orderInfo,
        EmailModify: input.emailModify,
        PeriodMemo: input.memo,
        NotifyURL: input.notifyUrl,
        ReturnURL: input.returnUrl,
        BackURL: input.backUrl,
      };
      return {
        mode: "redirect",
        action: `${origin}${NEWEBPAY_PATHS.period}`,
        method: "POST",
        params: {
          MerchantID_: merchantId,
          PostData_: encryptTradeInfo(buildQuery(fields), hashKey, hashIv),
        },
      };
    },

    async alterStatus(
      input: NewebpayPeriodAlterStatusInput,
    ): Promise<NewebpayPeriodAlterStatusResult> {
      requireMandateRef(input);
      if (!["suspend", "terminate", "restart"].includes(input.alterType)) {
        throw new PaymentError(
          "VALIDATION",
          `NewebPay AlterType 必須是 suspend|terminate|restart（收到 "${input.alterType}"）`,
          "newebpay-period",
        );
      }
      const { status, message, result, raw } = await postEnvelope(
        NEWEBPAY_PATHS.periodAlterStatus,
        {
          RespondType: "JSON",
          Version: NEWEBPAY_PERIOD_VERSIONS.alterStatus,
          MerOrderNo: input.orderId,
          PeriodNo: input.periodNo,
          AlterType: input.alterType,
          TimeStamp: epochSeconds(),
        },
        "period/AlterStatus",
      );
      return {
        status,
        message,
        merOrderNo: str(result.MerOrderNo),
        periodNo: str(result.PeriodNo),
        alterType: str(result.AlterType),
        newNextTime: str(result.NewNextTime),
        raw,
      };
    },

    async alterAmount(input: NewebpayPeriodAlterAmtInput): Promise<NewebpayPeriodAlterAmtResult> {
      requireMandateRef(input);
      // The gateway requires the pair together (documented on both fields).
      if ((input.periodType === undefined) !== (input.periodPoint === undefined)) {
        throw new PaymentError(
          "VALIDATION",
          "NewebPay AlterAmt 修改週期時 periodType 與 periodPoint 必須成對提供",
          "newebpay-period",
        );
      }
      if (input.cardExpiry !== undefined && input.periodTimes === undefined) {
        throw new PaymentError(
          "VALIDATION",
          "NewebPay AlterAmt 修改卡片到期日（cardExpiry）時必須同時提供 periodTimes",
          "newebpay-period",
        );
      }
      const { status, message, result, raw } = await postEnvelope(
        NEWEBPAY_PATHS.periodAlterAmt,
        {
          RespondType: "JSON",
          Version: NEWEBPAY_PERIOD_VERSIONS.alterAmt,
          TimeStamp: epochSeconds(),
          MerOrderNo: input.orderId,
          PeriodNo: input.periodNo,
          AlterAmt: input.amount !== undefined ? Math.round(input.amount) : undefined,
          PeriodType: input.periodType,
          PeriodPoint: input.periodPoint,
          PeriodTimes: input.periodTimes,
          Extday: input.cardExpiry,
          NotifyURL: input.notifyUrl,
        },
        "period/AlterAmt",
      );
      return {
        status,
        message,
        merOrderNo: str(result.MerOrderNo),
        periodNo: str(result.PeriodNo),
        amount: num(result.AlterAmt),
        periodType: str(result.PeriodType),
        periodPoint: str(result.PeriodPoint),
        newNextAmt: num(result.NewNextAmt),
        newNextTime: str(result.NewNextTime),
        periodTimes: num(result.PeriodTimes),
        cardExpiry: str(result.ExtDay) ?? str(result.Extday),
        notifyUrl: str(result.NotifyURL),
        raw,
      };
    },

    verifyPeriodCreateNotify(input: NewebpayNotifyInput): NewebpayPeriodCreateNotify {
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      return verifyPeriodCreateNotify(input, { merchantId, hashKey, hashIv });
    },

    verifyPeriodCycleNotify(input: NewebpayNotifyInput): NewebpayPeriodCycleNotify {
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      return verifyPeriodCycleNotify(input, { merchantId, hashKey, hashIv });
    },

    async getPayment(): Promise<NormalizedPaymentData> {
      assertSupports("newebpay-period", CAPABILITIES, "GET_PAYMENT");
      throw new Error("unreachable");
    },

    async refundPayment() {
      assertSupports("newebpay-period", CAPABILITIES, "REFUND_PAYMENT");
      throw new Error("unreachable");
    },
  };

  /** POST an encrypted MerchantID_/PostData_ envelope and decode the reply. */
  async function postEnvelope(
    path: string,
    fields: Record<string, string | number | undefined>,
    label: string,
  ): Promise<{ status: string; message: string; result: Record<string, unknown>; raw: unknown }> {
    const { merchantId, hashKey, hashIv } = requireCredentials(config);

    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          MerchantID_: merchantId,
          PostData_: encryptTradeInfo(buildQuery(fields), hashKey, hashIv),
        }),
      });
    } catch (err) {
      throw new PaymentError("NETWORK", `NewebPay ${label} 連線失敗`, "newebpay-period", {
        cause: err,
      });
    }
    if (!response.ok) {
      throw new PaymentError(
        "PROVIDER",
        `NewebPay ${label} failed: ${response.status} ${response.statusText}`,
        "newebpay-period",
        { rawCode: String(response.status) },
      );
    }
    const text = await response.text();
    if (process.env.PAID_DEBUG === "1") {
      console.error(`[newebpay-period] ${label} response:`, text);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new PaymentError("PROVIDER", `NewebPay ${label} 回應不是 JSON`, "newebpay-period", {
        raw: text,
      });
    }

    // Normal replies carry the encrypted `period`/`Period` envelope; some
    // rejections (e.g. an undecryptable request) come back as plain
    // Status/Message without one.
    if (body.Period === undefined && body.period === undefined) {
      const status = typeof body.Status === "string" ? body.Status : "";
      throw new PaymentError(
        mapNewebpayErrorCode(status),
        `NewebPay ${label} 失敗 ${status}: ${newebpayErrorMessage(
          status,
          typeof body.Message === "string" ? body.Message : undefined,
        )}`,
        "newebpay-period",
        { rawCode: status, rawMessage: str(body.Message), raw: body },
      );
    }

    const { decrypted, status, message, result } = decryptPeriodEnvelope(
      body as Record<string, string>,
      { merchantId, hashKey, hashIv },
    );
    if (status !== "SUCCESS") {
      throw new PaymentError(
        mapNewebpayErrorCode(status),
        `NewebPay ${label} 失敗 ${status}: ${newebpayErrorMessage(status, message)}`,
        "newebpay-period",
        { rawCode: status, rawMessage: message, raw: decrypted },
      );
    }
    return { status, message, result, raw: decrypted };
  }
}

function requireCredentials(config: NewebpayProviderConfig) {
  const { merchantId, hashKey, hashIv } = config;
  if (!merchantId || !hashKey || !hashIv) {
    throw new PaymentError(
      "AUTH",
      "缺少 NewebPay 憑證（MerchantID / HashKey / HashIV）",
      "newebpay-period",
    );
  }
  return { merchantId, hashKey, hashIv };
}

function requireMandateRef(input: { orderId: string; periodNo: string }): void {
  if (!input.orderId || !input.periodNo) {
    throw new PaymentError(
      "VALIDATION",
      "NewebPay 委託操作需要 orderId（MerOrderNo）與 periodNo（委託單號）",
      "newebpay-period",
    );
  }
}

function validateCreateInput(input: NewebpayPeriodCreateInput): void {
  if (input.currency && input.currency !== "TWD") {
    throw new PaymentError("VALIDATION", "NewebPay 定期定額僅支援 TWD", "newebpay-period");
  }
  if (input.method && input.method !== "card") {
    throw new PaymentError(
      "VALIDATION",
      `NewebPay 定期定額僅支援信用卡（method: "card"，收到 "${input.method}"）`,
      "newebpay-period",
    );
  }
  if (!/^[A-Za-z0-9_]{1,30}$/.test(input.orderId)) {
    throw new PaymentError(
      "VALIDATION",
      `NewebPay MerOrderNo 需為 1-30 碼英數字或底線（收到 "${input.orderId}"）`,
      "newebpay-period",
    );
  }
  if (!(input.prodDesc ?? input.itemDesc)) {
    throw new PaymentError(
      "VALIDATION",
      "NewebPay 定期定額需要 prodDesc（產品名稱，或以 itemDesc 帶入）",
      "newebpay-period",
    );
  }
  if (!input.payerEmail) {
    throw new PaymentError(
      "VALIDATION",
      "NewebPay 定期定額需要 payerEmail（付款人電子信箱）",
      "newebpay-period",
    );
  }
  if (!Number.isFinite(input.amount) || Math.round(input.amount) <= 0) {
    throw new PaymentError("VALIDATION", "NewebPay PeriodAmt 需為正整數（TWD）", "newebpay-period");
  }
  if (![1, 2, 3].includes(input.startType)) {
    throw new PaymentError(
      "VALIDATION",
      "NewebPay PeriodStartType 必須是 1、2 或 3",
      "newebpay-period",
    );
  }
  if (
    input.periodTimes !== "NE" &&
    (!Number.isInteger(input.periodTimes) || input.periodTimes < 1 || input.periodTimes > 99)
  ) {
    throw new PaymentError(
      "VALIDATION",
      'NewebPay PeriodTimes 需為 1-99 的整數（或 CAU 商店的 "NE"）',
      "newebpay-period",
    );
  }
  assertPeriodPoint(input.periodType, input.periodPoint);
  if (input.firstDate !== undefined && !(input.periodType === "D" && input.startType === 3)) {
    throw new PaymentError(
      "VALIDATION",
      'NewebPay PeriodFirstdate 僅在 periodType="D" 且 startType=3 時有效',
      "newebpay-period",
    );
  }
}

/** PeriodPoint ranges per PeriodType (NDNP field table). */
function assertPeriodPoint(type: NewebpayPeriodType, point: string): void {
  const fail = (expected: string) => {
    throw new PaymentError(
      "VALIDATION",
      `NewebPay PeriodPoint 與 PeriodType="${type}" 不符：${expected}（收到 "${point}"）`,
      "newebpay-period",
    );
  };
  switch (type) {
    case "D": {
      const days = Number(point);
      if (!/^\d+$/.test(point) || days < 2 || days > 999) fail("每 2-999 天");
      return;
    }
    case "W": {
      if (!/^[1-7]$/.test(point)) fail("1-7（週一至週日）");
      return;
    }
    case "M": {
      const day = Number(point);
      if (!/^\d{2}$/.test(point) || day < 1 || day > 31) fail("01-31（每月日期，兩位數）");
      return;
    }
    case "Y": {
      if (!/^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(point)) fail("MMDD（每年月日）");
      return;
    }
    default:
      throw new PaymentError(
        "VALIDATION",
        `NewebPay PeriodType 必須是 D、W、M 或 Y（收到 "${String(type)}"）`,
        "newebpay-period",
      );
  }
}

function epochSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function str(input: unknown): string | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  return String(input);
}

function num(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const value = Number(input);
  return Number.isNaN(value) ? undefined : value;
}
