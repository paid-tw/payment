import {
  assertSupports,
  type Capability,
  type CreatePaymentRequest,
  type GetPaymentRequest,
  type NormalizedPaymentData,
  PaymentError,
  type PaymentErrorCode,
  type PaymentProvider,
  type RefundPaymentRequest,
} from "@paid-tw/payment";
import {
  type EcpayCardInfoInput,
  type EcpayCardIssuerInfo,
  type EcpayCreditDetail,
  type EcpayCreditDetailInput,
  queryEcpayCardInfo,
  queryEcpayCreditDetail,
} from "../credit/queries.js";
import { ecpgPost } from "../ecpg/client.js";
import { asNumber, str, text } from "../scalars.js";
import {
  ECPAY_BACKAUTH_ORIGINS,
  ECPAY_BACKAUTH_PATHS,
  type EcpayBackAuthProviderConfig,
  resolveBackAuthOrigin,
} from "./config.js";
import {
  type EcpayBackAuthNotify,
  type EcpayBackAuthNotifyEnvelope,
  verifyEcpayBackAuthNotify,
} from "./notify.js";

/**
 * Always available. `REFUND_PAYMENT` is added per instance — see
 * {@link resolveCapabilities}.
 */
const BASE_CAPABILITIES: readonly Capability[] = ["CREATE_PAYMENT", "GET_PAYMENT"];

/**
 * Capabilities are **per instance**, not per adapter, because refunds genuinely do
 * not exist on stage: ECPay does not expose `Credit/DoAction` there at all.
 *
 * `supports(provider, cap)` is this project's feature-detection contract, so a
 * sandbox-configured provider that advertised `REFUND_PAYMENT` would make the guard
 * lie — `if (supports(p, "REFUND_PAYMENT")) await p.refundPayment(...)` would still
 * throw. Reporting the capability the instance actually has keeps the guard honest.
 */
function resolveCapabilities(
  config: EcpayBackAuthProviderConfig,
  origin: string,
): ReadonlySet<Capability> {
  const capabilities = new Set<Capability>(BASE_CAPABILITIES);
  if (!isSandboxOrigin(config, origin)) capabilities.add("REFUND_PAYMENT");
  return capabilities;
}

/**
 * Sandbox if the flag says so **or** the resolved origin is the stage host.
 *
 * A real OR, unlike the first version of this function, which let `baseUrl` shadow
 * the flag entirely. That misclassified the realistic `{ sandbox: true, baseUrl:
 * "https://internal-proxy" }` setup — stage reached through a proxy — as production,
 * so it advertised `REFUND_PAYMENT` and went on to attempt a DoAction that cannot
 * exist. `resolveBackAuthOrigin` still lets `baseUrl` win for *routing*; that is a
 * separate question from which environment we are talking to.
 */
function isSandboxOrigin(config: EcpayBackAuthProviderConfig, origin: string): boolean {
  return Boolean(config.sandbox) || origin === ECPAY_BACKAUTH_ORIGINS.sandbox;
}

const PROVIDER = "ecpay-backauth";
const MESSAGE_PREFIX = "ECPay 幕後授權";

/** 請退款 actions, same letters as AIO's CreditDetail/DoAction. */
export type EcpayBackAuthAction = "C" | "R" | "E" | "N";

/**
 * Raw card details. **This is the PCI-DSS boundary.**
 *
 * Accepting a PAN in your own process puts that process in scope for SAQ D rather
 * than the much lighter SAQ A that ECPay's hosted flows (AIO / 站內付 2.0 / 幕後取號)
 * allow. Prefer those unless you specifically need card-not-present authorization
 * without a consumer-facing page.
 *
 * The adapter never logs, echoes or stores these values: they go into the encrypted
 * `Data` and are not copied into results or error payloads.
 */
export interface EcpayCardDetails {
  /** 13-19 digits, no spaces or dashes. */
  cardNo: string;
  /** Two digits, e.g. `"12"`. */
  expiryMonth: string;
  /** Two digits, e.g. `"30"`. */
  expiryYear: string;
  /** 3-4 digits. */
  cvv: string;
}

export interface EcpayBackAuthFields {
  card: EcpayCardDetails;
  /**
   * 3D 驗證回傳付款結果網址.
   *
   * ⚠️ **Required in practice**, even though doc 45958 does not mark it 必填 — stage
   * rejects a request without it as `RtnCode 5000029`
   * ("[3D Authorization return URL] Format is incorrect."), including on a merchant
   * with 3D switched off.
   */
  orderResultUrl: string;
  /** Cardholder phone, digits only, country code allowed without `+`. Required. */
  phone: string;
  /** Cardholder name, latin characters. Required. */
  cardholderName: string;
  email?: string;
  /** ISO-3166 numeric; Taiwan is `158`. */
  countryCode?: string;
  address?: string;
  /** Capture immediately on a successful authorization (關帳). Default `false`. */
  directCapture?: boolean;
  /** Installment periods, e.g. `3`. Omit or `0` for a single payment. */
  installments?: number;
  /** Redeem card loyalty points (紅利). Not supported for AmEx. */
  redeem?: boolean;
  /**
   * Turn this into a 定期定額 order. Mutually exclusive with `installments` — one splits a
   * single purchase, the other charges repeatedly.
   *
   * ⚠️ This schedules **real recurring charges**.
   */
  period?: EcpayPeriodSchedule;
  customField?: string;
}

/**
 * 定期定額 schedule. All four fields are required together — ECPay treats a partial
 * schedule as a malformed order rather than defaulting the rest.
 *
 * ⚠️ Creating one of these schedules a **recurring charge**. `execTimes` is how many
 * times ECPay will authorize, so the total taken is roughly `amount * execTimes`.
 */
export interface EcpayPeriodSchedule {
  /** Amount authorized on **each** cycle. */
  amount: number;
  /** `D` daily, `M` monthly, `Y` yearly. */
  type: "D" | "M" | "Y";
  /**
   * Cycles between charges. Bounded by `type`: `D` 1-365, `M` 1-12, `Y` exactly 1.
   *
   * With `D`/`M`, ECPay charges on the same day-of-period and falls back to the last day
   * of the month where that date does not exist.
   */
  frequency: number;
  /** Total authorizations. Max 999 for `D`/`M`, 99 for `Y`. */
  execTimes: number;
  /** Where each subsequent cycle's result is posted. Defaults to `notifyUrl`. */
  returnUrl?: string;
}

/** Period progress, from a query or a cycle notify. */
export interface EcpayPeriodProgress {
  type?: string;
  frequency?: number;
  execTimes?: number;
  /** Per-cycle amount as set when the order was created. */
  periodAmount?: number;
  /** How many cycles have authorized successfully so far. */
  totalSuccessTimes?: number;
  /** Sum authorized so far. */
  totalSuccessAmount?: number;
}

/**
 * 定期定額訂單作業.
 *
 * - `ReAuth` — retry a failed charge. ⚠️ Only the **latest** cycle can be retried: if
 *   cycle 2 failed but cycle 3 succeeded, cycle 2 is no longer recoverable.
 * - `Cancel` — stop all future charges. ⚠️ **Irreversible** — ECPay cannot re-enable a
 *   cancelled schedule; a new order is the only way back.
 */
export type EcpayPeriodAction = "ReAuth" | "Cancel";

export interface EcpayPeriodActionInput {
  orderId: string;
  action: EcpayPeriodAction;
}

export interface EcpayPeriodActionResult {
  action: EcpayPeriodAction;
  rtnCode: number;
  rtnMsg: string;
  merTradeNo?: string;
  raw: Record<string, unknown>;
}

/**
 * One authorization attempt from a 定期定額 schedule.
 *
 * **Undocumented** — doc 9093's field list does not mention `ExecLog` at all, but the
 * query really returns it, and it is the only place the per-cycle history exists:
 * counters tell you *how many* cycles succeeded, this tells you *which*, when, for how
 * much, and under which `TradeNo`. Reconciliation needs the latter.
 */
export interface EcpayPeriodExecution {
  /** `1` = this cycle authorized. */
  rtnCode?: number;
  amount?: number;
  /** 授權單號 for this cycle. */
  gwsr?: number;
  processDate?: string;
  authCode?: string;
  /** Each cycle gets its own gateway trade number. */
  tradeNo?: string;
  chargeFee?: number;
}

/** A 定期定額 order as the query reports it: the order, the card, and the progress. */
export interface EcpayPeriodOrder {
  merTradeNo: string;
  tradeNo?: string;
  /** First-cycle amount. Later cycles use {@link EcpayPeriodProgress.periodAmount}. */
  amount?: number;
  status: string;
  tradeDate?: string;
  paidAt?: string;
  card?: EcpayAuthCardInfo;
  period?: EcpayPeriodProgress;
  /**
   * Whether the schedule is still running. **Undocumented** — doc 9093 never mentions
   * `ExecStatus`, but the meaning was pinned by querying the same two orders before and
   * after `Cancel`: `"1"` while active, `"0"` once stopped. Surfaced as the raw string
   * because only those two values have been observed, and inventing a wider vocabulary
   * would be guessing. Prefer {@link EcpayPeriodOrder.isActive} for the common check.
   */
  execStatus?: string;
  /**
   * `execStatus === "1"`. Note that `status`/`TradeStatus` does **not** answer this: a
   * cancelled schedule whose first cycle succeeded still reports the trade as paid.
   */
  isActive: boolean;
  /** Per-cycle history, oldest first. Empty when the query returns none. */
  executions: EcpayPeriodExecution[];
  rtnCode: number;
  rtnMsg: string;
  raw: Record<string, unknown>;
}

export type EcpayBackAuthCreateInput = CreatePaymentRequest & EcpayBackAuthFields;

/** Masked card + bank data ECPay returns. Never contains the full PAN. */
export interface EcpayAuthCardInfo {
  authCode?: string;
  /**
   * 銀行授權碼 (gwsr) — the bank's authorization reference.
   *
   * **Not** what 請退款 takes: `creditDoAction` needs `tradeNo` (綠界交易編號). This is
   * the handle for 信用卡單筆明細查詢 (not implemented here) and for reconciliation.
   */
  gwsr?: number;
  processDate?: string;
  amount?: number;
  card6No?: string;
  card4No?: string;
  /** `5`/`6`/`2`/`1` mean the transaction went through 3D; `0` means it did not. */
  eci?: number;
  issuingBank?: string;
  issuingBankCode?: string;
  installments?: number;
  /** 首期金額, returned for instalment orders. */
  firstAmount?: number;
  /** 各期金額, returned for instalment orders. */
  eachAmount?: number;
}

/**
 * BackAuth answers **one of two structurally different payloads**, so the result is
 * a discriminated union rather than one optional-heavy object.
 *
 * The 3D branch is the dangerous one: it carries **no `RtnCode` at all** (verified
 * against stage), so a `RtnCode === 1` check would reject a perfectly good 3DS
 * response. Always branch on `mode` first.
 */
export type EcpayBackAuthResult = EcpayBackAuth3DSResult | EcpayBackAuthAuthorizedResult;

/** Consumer must be sent to `threeDUrl` — full page, never an iframe. */
export interface EcpayBackAuth3DSResult {
  mode: "3ds";
  merTradeNo: string;
  threeDUrl: string;
  raw: Record<string, unknown>;
}

/**
 * Authorization completed without 3D.
 *
 * `success` means the **authorization** succeeded — not necessarily that funds have
 * been captured. With `directCapture: false` (the default) the amount is authorized
 * and only settles at 關帳 (`creditDoAction("C")`), so a successful result is not yet
 * money in your account. `status` reports ECPay's own view of the order.
 */
export interface EcpayBackAuthAuthorizedResult {
  mode: "authorized";
  success: boolean;
  rtnCode: number;
  rtnMsg: string;
  merTradeNo: string;
  tradeNo?: string;
  amount?: number;
  /** `"paid"` (TradeStatus `1`) or `"unpaid"` (`0`); other values pass through. */
  status: string;
  tradeDate?: string;
  paidAt?: string;
  chargeFee?: number;
  processFee?: number;
  card?: EcpayAuthCardInfo;
  /**
   * Present only when the request carried a {@link EcpayPeriodSchedule} — ECPay echoes
   * the schedule back and already reports cycle 1 as charged, so a caller needs no
   * follow-up query to confirm the schedule took effect.
   */
  period?: EcpayPeriodProgress;
  customField?: string;
  raw: Record<string, unknown>;
}

export interface EcpayBackAuthDoActionInput {
  orderId: string;
  tradeNo: string;
  action: EcpayBackAuthAction;
  amount: number;
}

/**
 * Refund input. Narrower than {@link RefundPaymentRequest} on purpose — both fields
 * are mandatory here.
 */
export interface EcpayBackAuthRefundInput extends RefundPaymentRequest {
  /** 綠界交易編號, from `result.tradeNo` or the notify's `tradeNo`. Not `gwsr`. */
  tradeNo: string;
  amount: number;
}

export interface EcpayBackAuthDoActionResult {
  action: EcpayBackAuthAction;
  rtnCode: number;
  rtnMsg: string;
  merTradeNo?: string;
  tradeNo?: string;
  raw: Record<string, unknown>;
}

export interface EcpayBackAuthProvider extends PaymentProvider {
  readonly name: "ecpay-backauth";
  /**
   * BackAuth — authorize a raw card number server-side.
   *
   * Returns `{ mode: "3ds" }` when the merchant has 3D verification on (redirect the
   * consumer to `threeDUrl`, full page) or `{ mode: "authorized" }` when the
   * authorization settled directly. Check `mode` before anything else.
   */
  createPayment(input: EcpayBackAuthCreateInput): Promise<EcpayBackAuthResult>;
  /** QueryTrade — order + payment state by MerchantTradeNo. */
  getPayment(input: GetPaymentRequest): Promise<NormalizedPaymentData>;
  /**
   * Credit/DoAction — 關帳 `C` / 退刷 `R` / 取消 `E` / 放棄 `N`.
   *
   * ⚠️ **Production only**: stage has no such endpoint, so a sandbox-configured
   * provider throws `UNSUPPORTED` instead of issuing a doomed request.
   */
  creditDoAction(input: EcpayBackAuthDoActionInput): Promise<EcpayBackAuthDoActionResult>;
  /**
   * Convenience wrapper for `creditDoAction` with `action: "R"`. Production only.
   *
   * `tradeNo` and `amount` are **required**, unlike the base
   * {@link RefundPaymentRequest}: this API refunds by 綠界交易編號 and will not look it
   * up for you. Typed consumers therefore get a compile error rather than a runtime
   * VALIDATION. The runtime checks stay, because a caller holding the widened
   * `PaymentProvider` type can still reach this method without the narrowing.
   */
  refundPayment(input: EcpayBackAuthRefundInput): Promise<EcpayBackAuthDoActionResult>;
  /**
   * 定期定額訂單作業 — `ReAuth` or `Cancel`.
   *
   * ⚠️ `Cancel` is **irreversible**; ECPay cannot re-enable a stopped schedule.
   * ⚠️ `ReAuth` only applies to the **latest** cycle.
   */
  creditCardPeriodAction(input: EcpayPeriodActionInput): Promise<EcpayPeriodActionResult>;
  /**
   * 定期定額查詢 — the same `Cashier/QueryTrade` endpoint {@link getPayment} uses, but
   * returning the period progress that lives inside `CardInfo` and which the narrow
   * {@link NormalizedPaymentData} shape cannot carry.
   */
  queryPeriodOrder(input: GetPaymentRequest): Promise<EcpayPeriodOrder>;
  /**
   * 查詢信用卡單筆明細紀錄 — the authorization/capture history behind an order.
   *
   * Delegates to the shared {@link queryEcpayCreditDetail}; offered here because this
   * adapter already points at the `ecpayment` host the endpoint lives on. Callers not
   * using BackAuth should import that function directly rather than constructing a
   * provider just to reach it.
   */
  queryCreditDetail(input: EcpayCreditDetailInput): Promise<EcpayCreditDetail>;
  /**
   * 查詢信用卡發卡行 from a **BIN prefix** (6-9 digits, never a full card number).
   *
   * ⚠️ 閘道商-only: an ordinary merchant gets `UNSUPPORTED` (RtnCode 5000095).
   */
  queryCardInfo(input: EcpayCardInfoInput): Promise<EcpayCardIssuerInfo>;
  /** Verify a ReturnURL notify; respond with the ACK string. */
  verifyPaymentNotify(
    input: EcpayBackAuthNotifyEnvelope | string | Record<string, unknown>,
  ): EcpayBackAuthNotify;
}

/**
 * 信用卡幕後授權 (BackAuth) adapter — card-not-present authorization with no ECPay
 * page in the flow.
 *
 * ## PCI-DSS
 *
 * This is the only ECPay adapter in this package that touches a raw card number, and
 * that changes your compliance obligations: handling a PAN in your own
 * infrastructure means SAQ D, where AIO / 站內付 2.0 / 幕後取號 keep you at SAQ A
 * because the card never reaches you. Do not reach for this adapter merely because
 * it is convenient — it should be a deliberate decision with the rest of your
 * cardholder-data environment designed around it.
 *
 * ECPay additionally requires the merchant to have OTP switched off and 3D
 * verification applied for before BackAuth works at all.
 *
 * @see https://developers.ecpay.com.tw/45876
 */
export function createEcpayBackAuthProvider(
  config: EcpayBackAuthProviderConfig,
): EcpayBackAuthProvider {
  const origin = resolveBackAuthOrigin(config);
  const capabilities = resolveCapabilities(config, origin);

  async function post(
    path: string,
    data: Record<string, unknown>,
    label: string,
  ): Promise<Record<string, unknown>> {
    const { merchantId, hashKey, hashIv } = requireCredentials(config);
    return ecpgPost<Record<string, unknown>>({
      url: `${origin}${path}`,
      merchantId,
      hashKey,
      hashIv,
      data: config.platformId ? { PlatformID: config.platformId, ...data } : data,
      label,
      provider: PROVIDER,
      messagePrefix: MESSAGE_PREFIX,
    });
  }

  async function doAction(input: EcpayBackAuthDoActionInput): Promise<EcpayBackAuthDoActionResult> {
    // Environment first, credentials second. DoAction cannot work on stage no matter
    // what credentials are supplied, so reporting AUTH for a sandbox instance with
    // unset keys sends the caller off to find keys that would not have helped.
    assertDoActionAvailable(config, origin);
    const { merchantId } = requireCredentials(config);

    if (!["C", "R", "E", "N"].includes(input.action)) {
      throw new PaymentError(
        "VALIDATION",
        `${MESSAGE_PREFIX} DoAction Action 必須是 C|R|E|N（收到 "${input.action}"）`,
        PROVIDER,
      );
    }
    if (!input.orderId || !input.tradeNo) {
      throw new PaymentError(
        "VALIDATION",
        `${MESSAGE_PREFIX} DoAction 需要 orderId 與 tradeNo（綠界交易編號）`,
        PROVIDER,
      );
    }
    const amount = Math.round(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new PaymentError(
        "VALIDATION",
        `${MESSAGE_PREFIX} DoAction 需要正整數金額（收到 ${input.amount}）`,
        PROVIDER,
      );
    }

    const decoded = await post(
      ECPAY_BACKAUTH_PATHS.creditDoAction,
      {
        MerchantID: merchantId,
        MerchantTradeNo: input.orderId,
        TradeNo: input.tradeNo,
        Action: input.action,
        TotalAmount: amount,
      },
      `DoAction(${input.action})`,
    );
    assertRtnOk(decoded, `DoAction(${input.action})`);

    const rtnCode = Number(decoded.RtnCode);
    return {
      action: input.action,
      rtnCode: Number.isFinite(rtnCode) ? rtnCode : -1,
      rtnMsg: str(decoded.RtnMsg),
      merTradeNo: text(decoded.MerchantTradeNo),
      tradeNo: text(decoded.TradeNo),
      raw: decoded,
    };
  }

  return {
    name: PROVIDER,
    capabilities,

    async createPayment(input: EcpayBackAuthCreateInput): Promise<EcpayBackAuthResult> {
      assertSupports(PROVIDER, capabilities, "CREATE_PAYMENT");
      const { merchantId } = requireCredentials(config);
      const card = assertCreateInput(input);

      const data: Record<string, unknown> = {
        MerchantID: merchantId,
        ChoosePayment: "Credit",
        OrderInfo: {
          MerchantTradeNo: input.orderId,
          MerchantTradeDate: taipeiTradeDate(),
          TotalAmount: Math.round(input.amount),
          TradeDesc: input.itemDesc ?? "paid",
          ItemName: input.itemDesc ?? input.orderId,
          ReturnURL: input.notifyUrl,
        },
        CardInfo: {
          CardNo: card.cardNo,
          CardValidMM: card.expiryMonth,
          CardValidYY: card.expiryYear,
          CardCVV2: card.cvv,
          OrderResultURL: input.orderResultUrl,
          DirectCapture: input.directCapture ? "1" : "0",
          Redeem: input.redeem ? "Y" : "N",
          ...(input.installments ? { CreditInstallment: String(input.installments) } : {}),
          ...(input.period
            ? {
                PeriodAmount: Math.round(input.period.amount),
                PeriodType: input.period.type,
                Frequency: input.period.frequency,
                ExecTimes: input.period.execTimes,
                // Each later cycle reports here; ECPay needs somewhere to post them, so
                // fall back to ReturnURL rather than leaving cycles 2..n unreported.
                PeriodReturnURL: input.period.returnUrl ?? input.notifyUrl,
              }
            : {}),
        },
        ConsumerInfo: {
          Phone: input.phone,
          Name: input.cardholderName,
          ...(input.email ? { Email: input.email } : {}),
          CountryCode: input.countryCode ?? "158",
          ...(input.address ? { Address: input.address } : {}),
        },
        ...(input.customField ? { CustomField: input.customField } : {}),
      };

      const decoded = await post(ECPAY_BACKAUTH_PATHS.backAuth, data, "BackAuth");

      // ⚠️ Order matters. The 3D response carries ThreeDURL and *no* RtnCode
      // (verified against stage merchant 3002607), so checking RtnCode first would
      // reject a valid 3DS hand-off as a failure.
      const threeDUrl = text(decoded.ThreeDURL);
      if (threeDUrl) {
        return {
          mode: "3ds",
          merTradeNo: text(decoded.MerchantTradeNo) ?? input.orderId,
          threeDUrl,
          raw: decoded,
        };
      }

      assertRtnOk(decoded, "BackAuth");
      return normalizeAuthorized(decoded, input.orderId);
    },

    async getPayment(input: GetPaymentRequest): Promise<NormalizedPaymentData> {
      assertSupports(PROVIDER, capabilities, "GET_PAYMENT");
      const { merchantId } = requireCredentials(config);
      if (!input.merTradeNo) {
        throw new PaymentError(
          "VALIDATION",
          `${MESSAGE_PREFIX} 查詢需要 MerchantTradeNo（--id）`,
          PROVIDER,
        );
      }

      const decoded = await post(
        ECPAY_BACKAUTH_PATHS.queryTrade,
        { MerchantID: merchantId, MerchantTradeNo: input.merTradeNo },
        "QueryTrade",
      );
      assertRtnOk(decoded, "QueryTrade");

      const orderInfo = asRecord(decoded.OrderInfo);
      return {
        status: mapTradeStatus(str(orderInfo.TradeStatus)),
        method: "card",
        amount: asNumber(orderInfo.TradeAmt),
        paidAt: text(orderInfo.PaymentDate),
        tradeNo: text(orderInfo.TradeNo),
        merTradeNo: text(orderInfo.MerchantTradeNo) ?? input.merTradeNo,
        raw: decoded,
      };
    },

    creditDoAction: doAction,

    async refundPayment(input: EcpayBackAuthRefundInput): Promise<EcpayBackAuthDoActionResult> {
      // Redundant with assertDoActionAvailable below, but keeps the capability guard
      // and the runtime behaviour in agreement for callers that feature-detect.
      assertSupports(PROVIDER, capabilities, "REFUND_PAYMENT");
      if (!input.tradeNo) {
        throw new PaymentError(
          "VALIDATION",
          `${MESSAGE_PREFIX} 退刷需要 tradeNo（綠界交易編號）；此 API 不會自行查詢`,
          PROVIDER,
        );
      }
      if (input.amount === undefined) {
        throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} 退刷需要 amount`, PROVIDER);
      }
      return doAction({
        orderId: input.orderId,
        tradeNo: input.tradeNo,
        action: "R",
        amount: input.amount,
      });
    },

    async creditCardPeriodAction(input: EcpayPeriodActionInput): Promise<EcpayPeriodActionResult> {
      assertSupports(PROVIDER, capabilities, "CREATE_PAYMENT");
      const { merchantId } = requireCredentials(config);
      if (input.action !== "ReAuth" && input.action !== "Cancel") {
        throw new PaymentError(
          "VALIDATION",
          `${MESSAGE_PREFIX} 定期定額作業 Action 需為 ReAuth 或 Cancel（收到 "${String(input.action)}"）`,
          PROVIDER,
        );
      }
      if (!input.orderId) {
        throw new PaymentError(
          "VALIDATION",
          `${MESSAGE_PREFIX} 定期定額作業需要 orderId（MerchantTradeNo）`,
          PROVIDER,
        );
      }

      const decoded = await post(
        ECPAY_BACKAUTH_PATHS.creditCardPeriodAction,
        { MerchantID: merchantId, MerchantTradeNo: input.orderId, Action: input.action },
        `CreditCardPeriodAction(${input.action})`,
      );
      assertRtnOk(decoded, `CreditCardPeriodAction(${input.action})`);

      const rtnCode = Number(decoded.RtnCode);
      return {
        action: input.action,
        rtnCode: Number.isFinite(rtnCode) ? rtnCode : -1,
        rtnMsg: str(decoded.RtnMsg),
        merTradeNo: text(decoded.MerchantTradeNo),
        raw: decoded,
      };
    },

    async queryPeriodOrder(input: GetPaymentRequest): Promise<EcpayPeriodOrder> {
      assertSupports(PROVIDER, capabilities, "GET_PAYMENT");
      const { merchantId } = requireCredentials(config);
      if (!input.merTradeNo) {
        throw new PaymentError(
          "VALIDATION",
          `${MESSAGE_PREFIX} 定期定額查詢需要 MerchantTradeNo`,
          PROVIDER,
        );
      }

      const decoded = await post(
        ECPAY_BACKAUTH_PATHS.queryTrade,
        { MerchantID: merchantId, MerchantTradeNo: input.merTradeNo },
        "QueryTrade(period)",
      );
      assertRtnOk(decoded, "QueryTrade(period)");

      const orderInfo = asRecord(decoded.OrderInfo);
      const cardInfo = asRecord(decoded.CardInfo);
      const rtnCode = Number(decoded.RtnCode);
      const period = normalizePeriodProgress(cardInfo);
      const execStatus = text(decoded.ExecStatus);

      return {
        merTradeNo: text(orderInfo.MerchantTradeNo) ?? input.merTradeNo,
        tradeNo: text(orderInfo.TradeNo),
        amount: asNumber(orderInfo.TradeAmt),
        status: mapTradeStatus(str(orderInfo.TradeStatus)),
        tradeDate: text(orderInfo.TradeDate),
        paidAt: text(orderInfo.PaymentDate),
        card: normalizeCardInfo(cardInfo),
        // Only present on an order that really is 定期定額 — a one-off has no PeriodType.
        period,
        execStatus,
        isActive: execStatus === "1",
        executions: normalizeExecLog(decoded.ExecLog),
        rtnCode: Number.isFinite(rtnCode) ? rtnCode : -1,
        rtnMsg: str(decoded.RtnMsg),
        raw: decoded,
      };
    },

    async queryCreditDetail(input: EcpayCreditDetailInput): Promise<EcpayCreditDetail> {
      assertSupports(PROVIDER, capabilities, "GET_PAYMENT");
      return queryEcpayCreditDetail(config, input);
    },

    async queryCardInfo(input: EcpayCardInfoInput): Promise<EcpayCardIssuerInfo> {
      assertSupports(PROVIDER, capabilities, "GET_PAYMENT");
      return queryEcpayCardInfo(config, input);
    },

    verifyPaymentNotify(
      input: EcpayBackAuthNotifyEnvelope | string | Record<string, unknown>,
    ): EcpayBackAuthNotify {
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      return verifyEcpayBackAuthNotify(input, { merchantId, hashKey, hashIv });
    },
  };
}

function normalizeAuthorized(
  decoded: Record<string, unknown>,
  fallbackOrderId: string,
): EcpayBackAuthAuthorizedResult {
  const orderInfo = asRecord(decoded.OrderInfo);
  const cardInfo = asRecord(decoded.CardInfo);
  const rtnCode = Number(decoded.RtnCode);

  const card = normalizeCardInfo(cardInfo);

  return {
    mode: "authorized",
    success: rtnCode === 1,
    rtnCode: Number.isFinite(rtnCode) ? rtnCode : -1,
    rtnMsg: str(decoded.RtnMsg),
    merTradeNo: text(orderInfo.MerchantTradeNo) ?? fallbackOrderId,
    tradeNo: text(orderInfo.TradeNo),
    amount: asNumber(orderInfo.TradeAmt),
    status: mapTradeStatus(str(orderInfo.TradeStatus)),
    tradeDate: text(orderInfo.TradeDate),
    paidAt: text(orderInfo.PaymentDate),
    chargeFee: asNumber(orderInfo.ChargeFee),
    processFee: asNumber(orderInfo.ProcessFee),
    card,
    // The create response echoes the schedule and already counts cycle 1 as charged,
    // so a 定期定額 caller gets the progress without a follow-up query. `undefined` on
    // an ordinary one-off, which has no PeriodType.
    period: normalizePeriodProgress(cardInfo),
    customField: text(decoded.CustomField),
    raw: decoded,
  };
}

/** Masked card + bank + instalment data. Shared by the authorize and query paths. */
function normalizeCardInfo(cardInfo: Record<string, unknown>): EcpayAuthCardInfo | undefined {
  const card: EcpayAuthCardInfo = {
    authCode: text(cardInfo.AuthCode),
    gwsr: asNumber(cardInfo.Gwsr),
    processDate: text(cardInfo.ProcessDate),
    amount: asNumber(cardInfo.Amount),
    card6No: text(cardInfo.Card6No),
    card4No: text(cardInfo.Card4No),
    eci: asNumber(cardInfo.Eci),
    issuingBank: text(cardInfo.IssuingBank),
    issuingBankCode: text(cardInfo.IssuingBankCode),
    installments: asNumber(cardInfo.Stage),
    firstAmount: asNumber(cardInfo.Stast),
    eachAmount: asNumber(cardInfo.Staed),
  };
  // Keyed off the fields that only exist once a card was actually charged, so a
  // response with an empty CardInfo does not surface an all-undefined object.
  return (card.authCode ?? card.card4No) ? card : undefined;
}

/**
 * `ExecLog` is undocumented, so treat its absence and its shape defensively — an array
 * when present, and `[]` rather than `undefined` so callers can always iterate.
 */
function normalizeExecLog(input: unknown): EcpayPeriodExecution[] {
  if (!Array.isArray(input)) return [];
  return (input as unknown[]).map((row) => {
    const r = asRecord(row);
    return {
      rtnCode: asNumber(r.RtnCode),
      amount: asNumber(r.Amount),
      gwsr: asNumber(r.Gwsr),
      processDate: text(r.ProcessDate),
      authCode: text(r.AuthCode),
      tradeNo: text(r.TradeNo),
      chargeFee: asNumber(r.ChargeFee),
    };
  });
}

/**
 * Period progress lives in `CardInfo`, not its own object. `PeriodType` is the marker
 * that an order really is 定期定額 — a one-off authorization has none, and returning a
 * progress object full of `undefined` would make a caller think it does.
 */
function normalizePeriodProgress(
  cardInfo: Record<string, unknown>,
): EcpayPeriodProgress | undefined {
  const type = text(cardInfo.PeriodType);
  if (!type) return undefined;
  return {
    type,
    frequency: asNumber(cardInfo.Frequency),
    execTimes: asNumber(cardInfo.ExecTimes),
    periodAmount: asNumber(cardInfo.PeriodAmount),
    totalSuccessTimes: asNumber(cardInfo.TotalSuccessTimes),
    totalSuccessAmount: asNumber(cardInfo.TotalSuccessAmount),
  };
}

/**
 * `Frequency` and `ExecTimes` bounds depend on `PeriodType`, so a shared range would be
 * wrong for two of the three.
 *
 * Taken from ECPay itself rather than the docs: probing out-of-range values on stage
 * makes it state each range verbatim, and it contradicts the documentation in one
 * important way — **`ExecTimes` starts at 2, not 1.** Doc 45958 gives only the maxima, so
 * a single-charge "schedule" looks legal and is rejected as `10100226`/`227`/`228`.
 *
 * Verified 2026-08-01:
 *   D → Frequency 1-365, ExecTimes 2-999
 *   M → Frequency 1-12,  ExecTimes 2-999
 *   Y → Frequency **exactly 1**, ExecTimes 2-99
 */
const PERIOD_RULES = {
  D: { minFrequency: 1, maxFrequency: 365, maxExecTimes: 999, label: "天" },
  M: { minFrequency: 1, maxFrequency: 12, maxExecTimes: 999, label: "月" },
  Y: { minFrequency: 1, maxFrequency: 1, maxExecTimes: 99, label: "年" },
} as const satisfies Record<
  EcpayPeriodSchedule["type"],
  { minFrequency: number; maxFrequency: number; maxExecTimes: number; label: string }
>;

/**
 * ECPay's own minimum. A 定期定額 order with one authorization is not recurring, so it is
 * rejected — the same value the docs imply is fine.
 */
const MIN_EXEC_TIMES = 2;

function assertPeriodSchedule(period: EcpayPeriodSchedule): void {
  const rule = PERIOD_RULES[period.type];
  if (!rule) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} period.type 需為 D / M / Y（收到 "${String(period.type)}"）`,
      PROVIDER,
    );
  }
  const amount = Math.round(period.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} period.amount 需為正整數（收到 ${String(period.amount)}）`,
      PROVIDER,
    );
  }
  if (
    !Number.isInteger(period.frequency) ||
    period.frequency < rule.minFrequency ||
    period.frequency > rule.maxFrequency
  ) {
    const range =
      rule.minFrequency === rule.maxFrequency
        ? `必須為 ${rule.maxFrequency}`
        : `需為 ${rule.minFrequency}-${rule.maxFrequency} ${rule.label}的整數`;
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} period.frequency（${period.type}）${range}` +
        `（收到 ${String(period.frequency)}）`,
      PROVIDER,
    );
  }
  if (
    !Number.isInteger(period.execTimes) ||
    period.execTimes < MIN_EXEC_TIMES ||
    period.execTimes > rule.maxExecTimes
  ) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} period.execTimes（${period.type}）需為 ` +
        `${MIN_EXEC_TIMES}-${rule.maxExecTimes} 的整數（收到 ${String(period.execTimes)}）；` +
        "定期定額至少要執行 2 次",
      PROVIDER,
    );
  }
}

function assertCreateInput(input: EcpayBackAuthCreateInput): EcpayCardDetails {
  if (input.currency && input.currency !== "TWD") {
    throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} 僅支援 TWD`, PROVIDER);
  }
  if (input.method !== "card") {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} 僅支援 method: "card"（非信用卡請用幕後取號）`,
      PROVIDER,
    );
  }
  if (!/^[A-Za-z0-9]{1,20}$/.test(input.orderId)) {
    throw new PaymentError(
      "VALIDATION",
      `ECPay MerchantTradeNo 需為 1-20 碼英數字（收到 "${input.orderId}"）`,
      PROVIDER,
    );
  }
  const amount = Math.round(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} TotalAmount 需為正整數（收到 ${input.amount}）`,
      PROVIDER,
    );
  }
  if (!input.notifyUrl) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} 需要 notify-url 作為 ReturnURL（必填）`,
      PROVIDER,
    );
  }
  if (!input.orderResultUrl) {
    // Doc 45958 does not mark OrderResultURL required, but stage rejects a request
    // without it as RtnCode 5000029 even on a merchant with 3D switched off.
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} 需要 orderResultUrl（OrderResultURL）；缺少時綠界回 RtnCode 5000029`,
      PROVIDER,
    );
  }
  if (!input.phone || !input.cardholderName) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} ConsumerInfo 需要 phone 與 cardholderName`,
      PROVIDER,
    );
  }
  if (input.period) {
    if (input.installments) {
      throw new PaymentError(
        "VALIDATION",
        `${MESSAGE_PREFIX} period 與 installments 不可併用（一個是分期付款，一個是定期定額）`,
        PROVIDER,
      );
    }
    assertPeriodSchedule(input.period);
  }
  return normalizeCard(input.card);
}

/**
 * Shape-only card validation, returning the **normalized** card to send.
 *
 * Every field is coerced through {@link str} first, for two reasons that only show up
 * with untyped callers (this is a published package, so they are real):
 *
 *   - A missing or `null` `cardNo` used to make the regex fail and then `.length`
 *     throw, turning a VALIDATION error into an unhandled `TypeError`.
 *   - A **numeric** `cardNo` passed validation (the regex coerces) and was then sent
 *     to ECPay as a JSON number rather than the documented string.
 *
 * Deliberately **no Luhn check**: ECPay's own published test card
 * (`4311952222222222`) fails Luhn, so enforcing it would make the vendor's
 * documented stage card unusable. Real-card validation belongs at the point of
 * collection, not here.
 */
function normalizeCard(card: EcpayCardDetails): EcpayCardDetails {
  const cardNo = str(card?.cardNo);
  const expiryMonth = str(card?.expiryMonth);
  const expiryYear = str(card?.expiryYear);
  const cvv = str(card?.cvv);

  if (!/^\d{13,19}$/.test(cardNo)) {
    // Never echo the value itself — only its length.
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} CardNo 需為 13-19 碼數字（收到 ${cardNo.length} 個字元）`,
      PROVIDER,
    );
  }
  if (!/^(0[1-9]|1[0-2])$/.test(expiryMonth)) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} CardValidMM 需為 01-12（收到 "${expiryMonth}"）`,
      PROVIDER,
    );
  }
  if (!/^\d{2}$/.test(expiryYear)) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} CardValidYY 需為 2 碼年份（收到 "${expiryYear}"）`,
      PROVIDER,
    );
  }
  if (!/^\d{3,4}$/.test(cvv)) {
    throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} CardCVV2 需為 3-4 碼數字`, PROVIDER);
  }
  return { cardNo, expiryMonth, expiryYear, cvv };
}

/** ECPay does not expose DoAction on stage at all, so fail before the network call. */
function assertDoActionAvailable(config: EcpayBackAuthProviderConfig, origin: string): void {
  if (isSandboxOrigin(config, origin)) {
    throw new PaymentError(
      "UNSUPPORTED",
      `${MESSAGE_PREFIX} Credit/DoAction 僅正式環境提供（綠界測試環境無法提供實際授權，` +
        "故未開放此 API）；請改用正式憑證或於廠商後台人工處理",
      PROVIDER,
    );
  }
}

/**
 * Business RtnCode → normalized error. `10300066` is the one worth special-casing:
 * it means "result pending, do not ship", which is neither success nor a hard
 * failure, so it maps to CONFLICT rather than being read as authorized.
 */
const RTN_ERRORS: Record<string, { code: PaymentErrorCode; message: string }> = {
  "5000029": { code: "VALIDATION", message: "OrderResultURL 格式錯誤或未帶入" },
  "10300066": { code: "CONFLICT", message: "交易付款結果待確認中，請勿出貨" },
  "10100248": { code: "PROVIDER", message: "拒絕交易，請客戶聯繫發卡行確認原因" },
  "10100251": { code: "PROVIDER", message: "卡片過期，請客戶檢查卡片重新交易" },
  "10100252": { code: "PROVIDER", message: "額度不足，請客戶檢查卡片額度或餘額" },
  "10100254": { code: "PROVIDER", message: "交易失敗，請客戶聯繫發卡行確認交易限制" },
  "10100255": { code: "PROVIDER", message: "報失卡，請客戶更換卡片重新交易" },
  "10100256": { code: "PROVIDER", message: "被盜用卡，請客戶更換卡片重新交易" },
  "10000185": { code: "NOT_FOUND", message: "查無交易資料" },
  // Verified on stage 2026-08-01 — one code per (field, PeriodType) pair.
  "10100223": { code: "VALIDATION", message: "Frequency 需為 1-365（PeriodType=D）" },
  "10100224": { code: "VALIDATION", message: "Frequency 需為 1-12（PeriodType=M）" },
  "10100225": { code: "VALIDATION", message: "Frequency 必須為 1（PeriodType=Y）" },
  "10100226": { code: "VALIDATION", message: "ExecTimes 需為 2-999（PeriodType=D）" },
  "10100227": { code: "VALIDATION", message: "ExecTimes 需為 2-999（PeriodType=M）" },
  "10100228": { code: "VALIDATION", message: "ExecTimes 需為 2-99（PeriodType=Y）" },
  // Verified: ReAuth on a cancelled schedule. Cancel is irreversible, so this is
  // terminal — CONFLICT rather than something to retry.
  "100006": { code: "CONFLICT", message: "該訂單已停用，無法補授權" },
};

function assertRtnOk(decoded: Record<string, unknown>, label: string): void {
  if (Number(decoded.RtnCode) === 1) return;

  const rawCode = str(decoded.RtnCode) || undefined;
  const rtnMsg = str(decoded.RtnMsg);
  const mapped = rawCode ? RTN_ERRORS[rawCode] : undefined;
  const detail = [mapped?.message, rtnMsg].filter(Boolean).join(" / ") || "未知錯誤";
  throw new PaymentError(
    mapped?.code ?? "PROVIDER",
    `${MESSAGE_PREFIX} ${label} 失敗 (RtnCode=${rawCode ?? "?"}): ${detail}`,
    PROVIDER,
    { rawCode, rawMessage: rtnMsg || mapped?.message, raw: decoded },
  );
}

function requireCredentials(config: EcpayBackAuthProviderConfig) {
  const { merchantId, hashKey, hashIv } = config;
  if (!merchantId || !hashKey || !hashIv) {
    throw new PaymentError(
      "AUTH",
      "缺少 ECPay 幕後授權憑證（MerchantID / HashKey / HashIV）",
      PROVIDER,
    );
  }
  return { merchantId, hashKey, hashIv };
}

function mapTradeStatus(value: string): string {
  switch (value) {
    case "1":
      return "paid";
    case "0":
      return "unpaid";
    default:
      return value || "unknown";
  }
}

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

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}
