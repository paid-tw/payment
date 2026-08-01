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

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "CREATE_PAYMENT",
  "GET_PAYMENT",
  "REFUND_PAYMENT",
]);

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
  customField?: string;
}

export type EcpayBackAuthCreateInput = CreatePaymentRequest & EcpayBackAuthFields;

/** Masked card + bank data ECPay returns. Never contains the full PAN. */
export interface EcpayAuthCardInfo {
  authCode?: string;
  /** 銀行授權碼 (gwsr) — the handle 請退款 needs. */
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

/** Authorization completed without 3D; `success` means the card was charged. */
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
  customField?: string;
  raw: Record<string, unknown>;
}

export interface EcpayBackAuthDoActionInput {
  orderId: string;
  tradeNo: string;
  action: EcpayBackAuthAction;
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
  /** Convenience wrapper for `creditDoAction` with `action: "R"`. Production only. */
  refundPayment(input: RefundPaymentRequest & { tradeNo?: string }): Promise<unknown>;
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
    const { merchantId } = requireCredentials(config);
    assertDoActionAvailable(config, origin);

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
    capabilities: CAPABILITIES,

    async createPayment(input: EcpayBackAuthCreateInput): Promise<EcpayBackAuthResult> {
      assertSupports(PROVIDER, CAPABILITIES, "CREATE_PAYMENT");
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
      assertSupports(PROVIDER, CAPABILITIES, "GET_PAYMENT");
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

    async refundPayment(input: RefundPaymentRequest & { tradeNo?: string }): Promise<unknown> {
      assertSupports(PROVIDER, CAPABILITIES, "REFUND_PAYMENT");
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
  };

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
    card: (card.authCode ?? card.card4No) ? card : undefined,
    customField: text(decoded.CustomField),
    raw: decoded,
  };
}

/** Validates the request and returns the normalized card to put on the wire. */
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
  const isSandbox = config.baseUrl
    ? origin === ECPAY_BACKAUTH_ORIGINS.sandbox
    : Boolean(config.sandbox);
  if (isSandbox) {
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
