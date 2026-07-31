import {
  assertSupports,
  type Capability,
  PaymentError,
  type CreatePaymentRequest,
  type GetPaymentRequest,
  type PaymentMethod,
  type PaymentProvider,
  type RefundPaymentRequest,
  type NormalizedPaymentData,
} from "@paid-tw/payment";
import { ecpgPost } from "./client.js";
import { type EcpgProviderConfig, resolveEcpgOrigin } from "./config.js";
import {
  type EcpgNotifyEnvelope,
  type EcpgPaymentNotify,
  verifyEcpgPaymentNotify,
} from "./notify.js";

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(["CREATE_PAYMENT"]);

/** Extra fields ECPG needs beyond the shared CreatePaymentRequest. */
export interface EcpgConsumerFields {
  /** Required unless {@link phone} is set. */
  email?: string;
  /** Required unless {@link email} is set. */
  phone?: string;
  consumerName?: string;
  /** Required when rememberCard is true. */
  memberId?: string;
  rememberCard?: boolean;
  /**
   * PaymentUIType ChoosePaymentList codes, comma-separated (e.g. `"1,3,4"`).
   * Defaults from {@link CreatePaymentRequest.method}.
   */
  choosePaymentList?: string;
}

export type EcpgCreatePaymentInput = CreatePaymentRequest & EcpgConsumerFields;

/**
 * Server step 1 result: hand `token` to ECPay JS `createPayment(Token)`.
 * Not a settled payment.
 */
export interface EcpgTokenResult {
  mode: "token";
  token: string;
  tokenExpireDate?: string;
  merchantTradeNo: string;
  /** Hint for frontend: load ECPay ECPG JS SDK then createPayment(token). */
  frontend: {
    /** Documented SDK init env: stage vs prod. */
    environment: "stage" | "prod";
  };
  raw: Record<string, unknown>;
}

export interface EcpgCreateWithPayTokenInput {
  payToken: string;
  merchantTradeNo: string;
}

/**
 * Server step 3 result after PayToken. May be immediate auth, 3DS URL, ATM info, etc.
 */
export interface EcpgCreatePaymentResult {
  mode: "ecpg_create";
  success: boolean;
  rtnCode: number;
  rtnMsg: string;
  merTradeNo?: string;
  tradeNo?: string;
  amount?: number;
  /** Present when card needs 3DS — open full-page (not iframe). */
  threeDUrl?: string;
  unionPayUrl?: string;
  atm?: { bankCode?: string; vAccount?: string; expireDate?: string };
  cvs?: { paymentNo?: string; expireDate?: string; paymentUrl?: string };
  barcode?: { barcode1?: string; barcode2?: string; barcode3?: string; expireDate?: string };
  raw: Record<string, unknown>;
}

export interface EcpayEcpgProvider extends PaymentProvider {
  readonly name: "ecpay-ecpg";
  /**
   * GetTokenbyTrade — returns embeddable payment Token (not a charge).
   * Requires email or phone on the input.
   */
  createPayment(input: EcpgCreatePaymentInput): Promise<EcpgTokenResult>;
  /** CreatePayment with browser PayToken (after JS getPayToken). */
  createPaymentWithPayToken(input: EcpgCreateWithPayTokenInput): Promise<EcpgCreatePaymentResult>;
  /**
   * Verify ReturnURL JSON notify (AES-decrypt Data).
   * Respond with {@link import("./notify.js").ECPG_NOTIFY_ACK} (`1|OK`).
   */
  verifyPaymentNotify(
    input: EcpgNotifyEnvelope | string | Record<string, unknown>,
  ): EcpgPaymentNotify;
}

/**
 * 站內付 2.0 (ECPG) adapter. Separate from AIO {@link import("../provider.js").createEcpayProvider}:
 * different host, AES JSON crypto, and create result (`mode: "token"`).
 *
 * Flow: createPayment → frontend JS → createPaymentWithPayToken → ReturnURL notify.
 */
export function createEcpayEcpgProvider(config: EcpgProviderConfig): EcpayEcpgProvider {
  const origin = resolveEcpgOrigin(config);

  return {
    name: "ecpay-ecpg",
    capabilities: CAPABILITIES,

    async createPayment(input: EcpgCreatePaymentInput): Promise<EcpgTokenResult> {
      assertSupports("ecpay-ecpg", CAPABILITIES, "CREATE_PAYMENT");
      const { merchantId, hashKey, hashIv } = requireCredentials(config);

      if (input.currency && input.currency !== "TWD") {
        throw new PaymentError("VALIDATION", "ECPay ECPG 僅支援 TWD", "ecpay-ecpg");
      }
      if (!input.notifyUrl) {
        throw new PaymentError(
          "VALIDATION",
          "ECPay ECPG 需要 notify-url 作為 ReturnURL",
          "ecpay-ecpg",
        );
      }
      if (!/^[A-Za-z0-9]{1,20}$/.test(input.orderId)) {
        throw new PaymentError(
          "VALIDATION",
          `ECPay MerchantTradeNo 需為 1-20 碼英數字（收到 "${input.orderId}"）`,
          "ecpay-ecpg",
        );
      }
      if (!input.email && !input.phone) {
        throw new PaymentError(
          "VALIDATION",
          "ECPay ECPG 需要 email 或 phone（ConsumerInfo）",
          "ecpay-ecpg",
        );
      }

      const rememberCard = input.rememberCard ? 1 : 0;
      if (rememberCard === 1 && !input.memberId) {
        throw new PaymentError(
          "VALIDATION",
          "RememberCard=1 時需要 memberId（MerchantMemberID）",
          "ecpay-ecpg",
        );
      }

      const choosePaymentList = input.choosePaymentList ?? mapChoosePaymentList(input.method);

      const data: Record<string, unknown> = {
        MerchantID: merchantId,
        RememberCard: rememberCard,
        PaymentUIType: 2,
        ChoosePaymentList: choosePaymentList,
        OrderInfo: {
          MerchantTradeDate: taipeiTradeDate(),
          MerchantTradeNo: input.orderId,
          TotalAmount: Math.round(input.amount),
          ReturnURL: input.notifyUrl,
          TradeDesc: input.itemDesc ?? "paid",
          ItemName: input.itemDesc ?? input.orderId,
        },
        CardInfo: {
          Redeem: 0,
          ...(input.returnUrl ? { OrderResultURL: input.returnUrl } : {}),
        },
        ConsumerInfo: {
          ...(input.memberId ? { MerchantMemberID: input.memberId } : {}),
          ...(input.email ? { Email: input.email } : {}),
          ...(input.phone ? { Phone: input.phone } : {}),
          ...(input.consumerName ? { Name: input.consumerName } : {}),
          CountryCode: "158",
        },
      };
      if (config.platformId) {
        data.PlatformID = config.platformId;
      }

      const decoded = await ecpgPost<Record<string, unknown>>({
        url: `${origin}/Merchant/GetTokenbyTrade`,
        merchantId,
        hashKey,
        hashIv,
        data,
        label: "GetTokenbyTrade",
      });

      const rtnCode = Number(decoded.RtnCode);
      if (rtnCode !== 1) {
        throw new PaymentError(
          "PROVIDER",
          `ECPay ECPG GetTokenbyTrade 失敗: ${decoded.RtnMsg ?? rtnCode}`,
          "ecpay-ecpg",
          {
            rawCode: String(decoded.RtnCode ?? ""),
            rawMessage: decoded.RtnMsg !== undefined ? String(decoded.RtnMsg) : undefined,
            raw: decoded,
          },
        );
      }

      const token = decoded.Token !== undefined ? String(decoded.Token) : "";
      if (!token) {
        throw new PaymentError("PROVIDER", "ECPay ECPG 回應缺少 Token", "ecpay-ecpg", {
          raw: decoded,
        });
      }

      return {
        mode: "token",
        token,
        tokenExpireDate:
          decoded.TokenExpireDate !== undefined ? String(decoded.TokenExpireDate) : undefined,
        merchantTradeNo: input.orderId,
        frontend: {
          environment: config.sandbox || config.baseUrl ? "stage" : "prod",
        },
        raw: decoded,
      };
    },

    async createPaymentWithPayToken(
      input: EcpgCreateWithPayTokenInput,
    ): Promise<EcpgCreatePaymentResult> {
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      if (!input.payToken || !input.merchantTradeNo) {
        throw new PaymentError(
          "VALIDATION",
          "ECPay ECPG CreatePayment 需要 payToken 與 merchantTradeNo",
          "ecpay-ecpg",
        );
      }

      const data: Record<string, unknown> = {
        MerchantID: merchantId,
        PayToken: input.payToken,
        MerchantTradeNo: input.merchantTradeNo,
      };
      if (config.platformId) {
        data.PlatformID = config.platformId;
      }

      const decoded = await ecpgPost<Record<string, unknown>>({
        url: `${origin}/Merchant/CreatePayment`,
        merchantId,
        hashKey,
        hashIv,
        data,
        label: "CreatePayment",
      });

      return normalizeCreatePaymentResult(decoded);
    },

    verifyPaymentNotify(
      input: EcpgNotifyEnvelope | string | Record<string, unknown>,
    ): EcpgPaymentNotify {
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      return verifyEcpgPaymentNotify(input, { merchantId, hashKey, hashIv });
    },

    async getPayment(_input: GetPaymentRequest): Promise<NormalizedPaymentData> {
      assertSupports("ecpay-ecpg", CAPABILITIES, "GET_PAYMENT");
      throw new PaymentError("UNSUPPORTED", "ECPay ECPG getPayment 尚未實作", "ecpay-ecpg");
    },

    async refundPayment(_input: RefundPaymentRequest): Promise<unknown> {
      assertSupports("ecpay-ecpg", CAPABILITIES, "REFUND_PAYMENT");
      throw new PaymentError("UNSUPPORTED", "ECPay ECPG refundPayment 尚未實作", "ecpay-ecpg");
    },
  };
}

function normalizeCreatePaymentResult(decoded: Record<string, unknown>): EcpgCreatePaymentResult {
  const rtnCode = Number(decoded.RtnCode);
  const success = rtnCode === 1;
  const orderInfo = (decoded.OrderInfo ?? {}) as Record<string, unknown>;
  const threeD = (decoded.ThreeDInfo ?? {}) as Record<string, unknown>;
  const union = (decoded.UnionPayInfo ?? {}) as Record<string, unknown>;
  const atm = (decoded.ATMInfo ?? {}) as Record<string, unknown>;
  const cvs = (decoded.CVSInfo ?? {}) as Record<string, unknown>;
  const barcode = (decoded.BarcodeInfo ?? {}) as Record<string, unknown>;

  return {
    mode: "ecpg_create",
    success,
    rtnCode: Number.isFinite(rtnCode) ? rtnCode : -1,
    rtnMsg: decoded.RtnMsg !== undefined ? String(decoded.RtnMsg) : "",
    merTradeNo:
      orderInfo.MerchantTradeNo !== undefined ? String(orderInfo.MerchantTradeNo) : undefined,
    tradeNo: orderInfo.TradeNo !== undefined ? String(orderInfo.TradeNo) : undefined,
    amount: asNumber(orderInfo.TradeAmt),
    threeDUrl: threeD.ThreeDURL !== undefined ? String(threeD.ThreeDURL) : undefined,
    unionPayUrl: union.UnionPayURL !== undefined ? String(union.UnionPayURL) : undefined,
    atm:
      atm.BankCode || atm.vAccount
        ? {
            bankCode: atm.BankCode !== undefined ? String(atm.BankCode) : undefined,
            vAccount: atm.vAccount !== undefined ? String(atm.vAccount) : undefined,
            expireDate: atm.ExpireDate !== undefined ? String(atm.ExpireDate) : undefined,
          }
        : undefined,
    cvs: cvs.PaymentNo
      ? {
          paymentNo: String(cvs.PaymentNo),
          expireDate: cvs.ExpireDate !== undefined ? String(cvs.ExpireDate) : undefined,
          paymentUrl: cvs.PaymentURL !== undefined ? String(cvs.PaymentURL) : undefined,
        }
      : undefined,
    barcode: barcode.Barcode1
      ? {
          barcode1: String(barcode.Barcode1),
          barcode2: barcode.Barcode2 !== undefined ? String(barcode.Barcode2) : undefined,
          barcode3: barcode.Barcode3 !== undefined ? String(barcode.Barcode3) : undefined,
          expireDate: barcode.ExpireDate !== undefined ? String(barcode.ExpireDate) : undefined,
        }
      : undefined,
    raw: decoded,
  };
}

function mapChoosePaymentList(method?: PaymentMethod): string {
  switch (method) {
    case "card":
      return "1";
    case "atm":
      return "3";
    case "cvs":
      return "4";
    default:
      return "1,3,4";
  }
}

function requireCredentials(config: EcpgProviderConfig) {
  const { merchantId, hashKey, hashIv } = config;
  if (!merchantId || !hashKey || !hashIv) {
    throw new PaymentError(
      "AUTH",
      "缺少 ECPay ECPG 憑證（MerchantID / HashKey / HashIV）",
      "ecpay-ecpg",
    );
  }
  return { merchantId, hashKey, hashIv };
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

function asNumber(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const num = Number(input);
  return Number.isNaN(num) ? undefined : num;
}
