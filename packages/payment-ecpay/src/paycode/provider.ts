import {
  assertSupports,
  type Capability,
  type CreatePaymentRequest,
  type GetPaymentRequest,
  type NormalizedPaymentData,
  PaymentError,
  type PaymentErrorCode,
  type PaymentMethod,
  type PaymentProvider,
  type RefundPaymentRequest,
} from "@paid-tw/payment";
import { ecpgPost, ecpgPostForText } from "../ecpg/client.js";
import { asNumber, str } from "../scalars.js";
import {
  ECPAY_PAYCODE_PATHS,
  type EcpayPayCodeProviderConfig,
  resolvePayCodeOrigin,
} from "./config.js";
import {
  type EcpayPayCodeNotify,
  type EcpayPayCodeNotifyEnvelope,
  verifyEcpayPayCodeNotify,
} from "./notify.js";

const CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "CREATE_PAYMENT",
  "GET_PAYMENT",
]);

const PROVIDER = "ecpay-paycode";
const MESSAGE_PREFIX = "ECPay 幕後取號";

/** The three non-card methods 幕後取號 covers. Credit card uses BackAuth instead. */
export type EcpayPayCodeMethod = "atm" | "cvs" | "barcode";

/** ECPay `CVSInfo.CVSCode` — which chain's kiosk the code is valid at. */
export type EcpayCvsChain = "CVS" | "OK" | "FAMILY" | "HILIFE" | "IBON";

/**
 * `ExpireDate` bounds per method. **The unit differs by method** — this is the
 * easiest thing to get wrong, so the adapter validates rather than forwarding a
 * value ECPay would silently reinterpret.
 *
 * CVS is the one case where ECPay itself clamps (`超過時一律以 43200 分鐘計算`); we
 * still reject, because a caller passing e.g. `604800` almost certainly thinks the
 * unit is seconds and would get a 30-day code without noticing.
 */
const EXPIRE_RULES = {
  atm: { unit: "天", default: 3, min: 1, max: 60 },
  cvs: { unit: "分鐘", default: 10_080, min: 1, max: 43_200 },
  barcode: { unit: "天", default: 7, min: 1, max: 30 },
} as const satisfies Record<
  EcpayPayCodeMethod,
  { unit: string; default: number; min: number; max: number }
>;

/** Extra fields 幕後取號 accepts beyond the shared CreatePaymentRequest. */
export interface EcpayPayCodeFields {
  /**
   * 繳費期限. Unit depends on the method — ATM/BARCODE count **days**, CVS counts
   * **minutes**. Defaults: ATM 3 days, CVS 10080 minutes (7 days), BARCODE 7 days.
   * Over 30 days needs a 特約賣家 application with ECPay.
   */
  expireDate?: number;
  /**
   * ATM only — pin the paying bank (see ECPay's 銀行代碼表). An unsupported or
   * omitted code falls back to ECPay's default bank.
   *
   * Picking 007 / 822 / 118 / 013 / 809 makes ECPay return the payer's own account
   * digits on the notify, which is what lets you reconcile against the remitter.
   */
  atmBankCode?: string;
  /** CVS only — which chain (default `"CVS"`, i.e. all of them). */
  cvsChain?: EcpayCvsChain;
  /** CVS only — up to 4 lines shown on FAMILY / IBON kiosk screens (20 chars each). */
  cvsDescriptions?: readonly string[];
  /** 備註, echoed back by ECPay. */
  remark?: string;
  /** 自訂欄位, echoed back on the response and the notify. */
  customField?: string;
}

export type EcpayPayCodeCreateInput = CreatePaymentRequest & EcpayPayCodeFields;

/** 虛擬帳號 — what the consumer transfers to at an ATM. */
export interface EcpayAtmCode {
  bankCode?: string;
  vAccount?: string;
  /** `yyyy/MM/dd` — the account dies at 23:59 that day. */
  expireDate?: string;
}

/** 超商代碼 — keyed into the in-store kiosk. */
export interface EcpayCvsCode {
  paymentNo?: string;
  /** `yyyy/MM/dd HH:mm:ss`. */
  expireDate?: string;
  /** ECPay-hosted page rendering the three-segment barcode for phones. */
  paymentUrl?: string;
}

/** 超商條碼 — three Code39 segments. ECPay returns the digits, not an image. */
export interface EcpayBarcodeCode {
  barcode1?: string;
  barcode2?: string;
  barcode3?: string;
  /** `yyyy/MM/dd HH:mm:ss`. */
  expireDate?: string;
}

/**
 * A completed 取號: the payment code exists and the order is live, but **nothing is
 * paid yet** (`status` is `"unpaid"` until the ReturnURL notify lands).
 */
export interface EcpayPayCodeResult {
  mode: "paycode";
  method: EcpayPayCodeMethod;
  merTradeNo: string;
  tradeNo?: string;
  amount?: number;
  /**
   * `"unpaid"` (TradeStatus `"0"`) or `"paid"` (`"1"`) — a fresh 取號 is always
   * `"unpaid"`. Any other TradeStatus is passed through verbatim, and `"unknown"`
   * stands in when the field is absent, so treat this as an open string: ECPay adds
   * states over time and collapsing them would discard information.
   */
  status: string;
  tradeDate?: string;
  paidAt?: string;
  chargeFee?: number;
  rtnCode: number;
  rtnMsg: string;
  /** The method-specific expiry, normalized out of the nested Info object. */
  expireDate?: string;
  atm?: EcpayAtmCode;
  cvs?: EcpayCvsCode;
  barcode?: EcpayBarcodeCode;
  customField?: string;
  raw: Record<string, unknown>;
}

/**
 * Chains whose kiosks can render a CVS 繳費代碼 as a scannable barcode.
 *
 * Deliberately narrower than {@link EcpayCvsChain}: `CVS` (all chains) and `OK` are
 * **not** supported by the conversion API, and the odd casing (`iBon`, not `IBON`)
 * is ECPay's, not a typo.
 */
export type EcpayCvsBarcodeChain = "Family" | "Hilife" | "iBon";

/**
 * Three-segment barcode derived from a 繳費代碼.
 *
 * Short-lived: each conversion is valid for **10 minutes**, so fetch it when you are
 * about to show it, not at 取號 time.
 */
export interface EcpayCvsBarcodeResult {
  paymentNo: string;
  chain: EcpayCvsBarcodeChain;
  barcode1?: string;
  barcode2?: string;
  barcode3?: string;
  /** Payment deadline of the underlying order, `yyyy/MM/dd HH:mm:ss`. */
  expireDate?: string;
  rtnCode: number;
  rtnMsg: string;
  raw: Record<string, unknown>;
}

/** 撥款對帳檔 query. `1` = 結算日期, `2` = 撥款日期. */
export interface EcpayTradeMediaQuery {
  dateType: "1" | "2";
  /** `yyyy-MM-dd`. The range may not exceed one month. */
  beginDate: string;
  /** `yyyy-MM-dd`. */
  endDate: string;
  /** Omit for all methods. `03` ATM / `04` 超商代碼 / `05` 超商條碼. */
  paymentType?: "03" | "04" | "05";
}

/**
 * Raw CSV reconciliation report.
 *
 * Returned verbatim so a column ECPay adds later cannot be silently dropped — the
 * real file already has a 13th column (`金流處理費`) that doc 41186's list omits.
 * Use {@link parseTradeMediaCsv} instead of splitting it yourself: every cell is
 * Excel-armoured as `="value"`.
 */
export interface EcpayTradeMediaResult {
  /** Verbatim CSV text as ECPay returned it. */
  csv: string;
  /** Observed as `text/plain`, not `text/csv`. */
  contentType: string | null;
}

/**
 * Parse a 撥款對帳檔 into rows keyed by ECPay's own column headers.
 *
 * Handles the two things that make this file hostile to a naive parser:
 * every cell arrives Excel-armoured as `="value"` (the spreadsheet idiom for
 * forcing text so long trade numbers survive), and the column set is not fixed.
 * Headers are taken from row 1 rather than assumed, so an added column shows up as
 * a new key instead of shifting every value.
 *
 * Returns `[]` for an empty report, which ECPay expresses as a header row alone.
 */
export function parseTradeMediaCsv(csv: string): Record<string, string>[] {
  const rows = csv
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => line.split(",").map(unarmour));
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""])));
}

/** Strip ECPay's `="value"` Excel armour, leaving a plain cell value. */
function unarmour(cell: string): string {
  const trimmed = cell.trim();
  // `noUncheckedIndexedAccess` makes a capture group `string | undefined`, and it
  // genuinely can be for a zero-length cell (`=""`), so default rather than assert.
  const armoured = /^="(.*)"$/.exec(trimmed);
  if (armoured) return armoured[1] ?? "";
  return trimmed.replace(/^"(.*)"$/, "$1");
}

export interface EcpayPayCodeProvider extends PaymentProvider {
  readonly name: "ecpay-paycode";
  /**
   * GenPaymentCode — obtain an ATM 虛擬帳號 / 超商代碼 / 超商條碼 server-side, with no
   * consumer redirect. Requires `notifyUrl` (ReturnURL) and an `atm` / `cvs` /
   * `barcode` method.
   */
  createPayment(input: EcpayPayCodeCreateInput): Promise<EcpayPayCodeResult>;
  /** QueryTrade — order + payment state by MerchantTradeNo. */
  getPayment(input: GetPaymentRequest): Promise<NormalizedPaymentData>;
  /**
   * QueryPaymentInfo — re-read the payment code itself (virtual account, code,
   * barcode segments). Use this to re-display a code you failed to persist; the
   * codes are only returned once, at 取號 time.
   */
  getPaymentCode(input: GetPaymentRequest): Promise<EcpayPayCodeResult>;
  /**
   * QueryCVSBarcode — convert a 超商代碼 into three barcode segments the consumer can
   * have scanned at the counter instead of keying the code in.
   *
   * Fails once the order is paid or expired, and the result only lives 10 minutes.
   */
  getCvsBarcode(input: EcpayCvsBarcodeInput): Promise<EcpayCvsBarcodeResult>;
  /**
   * QueryTradeMedia — download the 撥款對帳檔 as CSV.
   *
   * Two operational constraints ECPay enforces server-side: the calling IP must be
   * allow-listed (廠商後台 → 系統開發管理 → 系統介接設定), and only **one file per
   * minute** is permitted.
   */
  downloadTradeMedia(input: EcpayTradeMediaQuery): Promise<EcpayTradeMediaResult>;
  /** Verify a ReturnURL notify; respond with {@link ECPAY_PAYCODE_NOTIFY_ACK}. */
  verifyPaymentNotify(
    input: EcpayPayCodeNotifyEnvelope | string | Record<string, unknown>,
  ): EcpayPayCodeNotify;
}

export interface EcpayCvsBarcodeInput {
  /** The 繳費代碼 from a CVS 取號. */
  paymentNo: string;
  chain: EcpayCvsBarcodeChain;
}

/**
 * 非信用卡幕後取號 (ECPay's "background take-number") adapter.
 *
 * Unlike {@link import("../provider.js").createEcpayProvider} (AIO), the consumer
 * never sees an ECPay page: you POST the order and get the payment code back in
 * the same response, then deliver it yourself (email / SMS / your own page).
 *
 * A third ECPay origin and crypto scheme, hence a third factory:
 *
 * | | AIO `ecpay` | ECPG `ecpay-ecpg` | 幕後取號 `ecpay-paycode` |
 * | --- | --- | --- | --- |
 * | Host | `payment.ecpay.com.tw` | `ecpg.ecpay.com.tw` | `ecpayment.ecpay.com.tw` |
 * | Auth | CheckMacValue (SHA256) | AES-128-CBC `Data` | AES-128-CBC `Data` |
 * | Create result | redirect form | embed token | **the payment code itself** |
 *
 * @see https://developers.ecpay.com.tw/27950
 */
export function createEcpayPayCodeProvider(
  config: EcpayPayCodeProviderConfig,
): EcpayPayCodeProvider {
  const origin = resolvePayCodeOrigin(config);

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

  return {
    name: PROVIDER,
    capabilities: CAPABILITIES,

    async createPayment(input: EcpayPayCodeCreateInput): Promise<EcpayPayCodeResult> {
      assertSupports(PROVIDER, CAPABILITIES, "CREATE_PAYMENT");
      const { merchantId } = requireCredentials(config);
      const method = requirePayCodeMethod(input.method);

      if (input.currency && input.currency !== "TWD") {
        throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} 僅支援 TWD`, PROVIDER);
      }
      if (!input.notifyUrl) {
        throw new PaymentError(
          "VALIDATION",
          `${MESSAGE_PREFIX} 需要 notify-url 作為 ReturnURL（必填）`,
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

      const expireDate = resolveExpireDate(method, input.expireDate);
      const itemName = input.itemDesc ?? input.orderId;

      const data: Record<string, unknown> = {
        MerchantID: merchantId,
        ChoosePayment: CHOOSE_PAYMENT[method],
        OrderInfo: {
          MerchantTradeNo: input.orderId,
          MerchantTradeDate: taipeiTradeDate(),
          TotalAmount: amount,
          ReturnURL: input.notifyUrl,
          TradeDesc: input.itemDesc ?? "paid",
          ItemName: itemName,
          ...(input.remark ? { Remark: input.remark } : {}),
        },
        ...buildMethodInfo(method, expireDate, input),
        ...(input.customField ? { CustomField: input.customField } : {}),
      };

      const decoded = await post(ECPAY_PAYCODE_PATHS.genPaymentCode, data, "GenPaymentCode");
      assertRtnOk(decoded, "GenPaymentCode");
      const result = normalizePayCode(decoded, method);

      if (!hasCode(result)) {
        throw new PaymentError(
          "PROVIDER",
          `${MESSAGE_PREFIX} 回應 RtnCode=${result.rtnCode} 但沒有繳費資訊`,
          PROVIDER,
          { rawCode: String(result.rtnCode), rawMessage: result.rtnMsg, raw: decoded },
        );
      }
      return result;
    },

    async getPayment(input: GetPaymentRequest): Promise<NormalizedPaymentData> {
      assertSupports(PROVIDER, CAPABILITIES, "GET_PAYMENT");
      const merTradeNo = requireMerTradeNo(input);
      const decoded = await post(
        ECPAY_PAYCODE_PATHS.queryTrade,
        { MerchantID: requireCredentials(config).merchantId, MerchantTradeNo: merTradeNo },
        "QueryTrade",
      );
      assertRtnOk(decoded, "QueryTrade");

      const orderInfo = asRecord(decoded.OrderInfo);
      return {
        status: mapTradeStatus(str(orderInfo.TradeStatus)),
        method: mapPaymentType(str(orderInfo.PaymentType)),
        amount: asNumber(orderInfo.TradeAmt),
        paidAt: str(orderInfo.PaymentDate) || undefined,
        tradeNo: str(orderInfo.TradeNo) || undefined,
        merTradeNo: str(orderInfo.MerchantTradeNo) || merTradeNo,
        raw: decoded,
      };
    },

    async getPaymentCode(input: GetPaymentRequest): Promise<EcpayPayCodeResult> {
      assertSupports(PROVIDER, CAPABILITIES, "GET_PAYMENT");
      const merTradeNo = requireMerTradeNo(input);
      const decoded = await post(
        ECPAY_PAYCODE_PATHS.queryPaymentInfo,
        { MerchantID: requireCredentials(config).merchantId, MerchantTradeNo: merTradeNo },
        "QueryPaymentInfo",
      );
      assertRtnOk(decoded, "QueryPaymentInfo");
      return normalizePayCode(decoded);
    },

    async getCvsBarcode(input: EcpayCvsBarcodeInput): Promise<EcpayCvsBarcodeResult> {
      assertSupports(PROVIDER, CAPABILITIES, "GET_PAYMENT");
      const { merchantId } = requireCredentials(config);
      if (!input.paymentNo) {
        throw new PaymentError(
          "VALIDATION",
          `${MESSAGE_PREFIX} 轉條碼需要 paymentNo（CVS 繳費代碼）`,
          PROVIDER,
        );
      }
      if (!CVS_BARCODE_CHAINS.has(input.chain)) {
        throw new PaymentError(
          "VALIDATION",
          `${MESSAGE_PREFIX} CVSType 僅支援 ${[...CVS_BARCODE_CHAINS].join(" / ")}` +
            `（收到 "${input.chain}"）；CVS 與 OK 不支援轉三段式條碼`,
          PROVIDER,
        );
      }

      const decoded = await post(
        ECPAY_PAYCODE_PATHS.queryCvsBarcode,
        { MerchantID: merchantId, PaymentNo: input.paymentNo, CVSType: input.chain },
        "QueryCVSBarcode",
      );
      assertRtnOk(decoded, "QueryCVSBarcode");

      const cvsInfo = asRecord(decoded.CVSInfo);
      const rtnCode = Number(decoded.RtnCode);
      return {
        paymentNo: input.paymentNo,
        chain: input.chain,
        barcode1: str(cvsInfo.Barcode1) || undefined,
        barcode2: str(cvsInfo.Barcode2) || undefined,
        barcode3: str(cvsInfo.Barcode3) || undefined,
        expireDate: str(cvsInfo.ExpireDate) || undefined,
        rtnCode: Number.isFinite(rtnCode) ? rtnCode : -1,
        rtnMsg: str(decoded.RtnMsg),
        raw: decoded,
      };
    },

    async downloadTradeMedia(input: EcpayTradeMediaQuery): Promise<EcpayTradeMediaResult> {
      assertSupports(PROVIDER, CAPABILITIES, "GET_PAYMENT");
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      assertTradeMediaQuery(input);

      const { text, contentType } = await ecpgPostForText({
        url: `${origin}${ECPAY_PAYCODE_PATHS.queryTradeMedia}`,
        merchantId,
        hashKey,
        hashIv,
        data: {
          MerchantID: merchantId,
          DateType: input.dateType,
          BeginDate: input.beginDate,
          EndDate: input.endDate,
          ...(input.paymentType ? { PaymentType: input.paymentType } : {}),
        },
        label: "QueryTradeMedia",
        provider: PROVIDER,
        messagePrefix: MESSAGE_PREFIX,
      });

      return { csv: text, contentType };
    },

    verifyPaymentNotify(
      input: EcpayPayCodeNotifyEnvelope | string | Record<string, unknown>,
    ): EcpayPayCodeNotify {
      const { merchantId, hashKey, hashIv } = requireCredentials(config);
      return verifyEcpayPayCodeNotify(input, { merchantId, hashKey, hashIv });
    },

    async refundPayment(_input: RefundPaymentRequest): Promise<unknown> {
      // Not a capability gap we can close: ATM/CVS/BARCODE are cash-in, so ECPay
      // offers no refund API at all for them — refunds go through 廠商後台 by hand.
      throw new PaymentError(
        "UNSUPPORTED",
        `${MESSAGE_PREFIX} 不支援線上退款（ATM/超商代碼/超商條碼需於綠界廠商後台人工退款）`,
        PROVIDER,
      );
    },
  };
}

/** ECPay's own casing — `iBon`, not `IBON`. `CVS`/`OK` are rejected by the API. */
const CVS_BARCODE_CHAINS: ReadonlySet<string> = new Set(["Family", "Hilife", "iBon"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** ECPay caps the 撥款對帳檔 window at one month. */
const MAX_MEDIA_RANGE_DAYS = 31;

function assertTradeMediaQuery(input: EcpayTradeMediaQuery): void {
  if (input.dateType !== "1" && input.dateType !== "2") {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} DateType 需為 "1"（結算日期）或 "2"（撥款日期）`,
      PROVIDER,
    );
  }
  for (const [label, value] of [
    ["beginDate", input.beginDate],
    ["endDate", input.endDate],
  ] as const) {
    if (!ISO_DATE.test(value)) {
      throw new PaymentError(
        "VALIDATION",
        `${MESSAGE_PREFIX} ${label} 需為 yyyy-MM-dd（收到 "${value}"）`,
        PROVIDER,
      );
    }
  }

  const begin = Date.parse(`${input.beginDate}T00:00:00Z`);
  const end = Date.parse(`${input.endDate}T00:00:00Z`);
  if (Number.isNaN(begin) || Number.isNaN(end)) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} beginDate / endDate 不是有效日期`,
      PROVIDER,
    );
  }
  // ECPay's own doc sample has BeginDate after EndDate, which returns nothing —
  // catch the swap locally rather than shipping an empty report.
  if (begin > end) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} beginDate (${input.beginDate}) 不可晚於 endDate (${input.endDate})`,
      PROVIDER,
    );
  }
  const days = (end - begin) / 86_400_000;
  if (days > MAX_MEDIA_RANGE_DAYS) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} 對帳檔查詢區間最大 1 個月（收到 ${days} 天）`,
      PROVIDER,
    );
  }
  if (input.paymentType && !["03", "04", "05"].includes(input.paymentType)) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} PaymentType 需為 03（ATM）/ 04（超商代碼）/ 05（超商條碼）`,
      PROVIDER,
    );
  }
}

const CHOOSE_PAYMENT: Record<EcpayPayCodeMethod, string> = {
  atm: "ATM",
  cvs: "CVS",
  barcode: "BARCODE",
};

function requirePayCodeMethod(method: PaymentMethod | undefined): EcpayPayCodeMethod {
  if (method === "atm" || method === "cvs" || method === "barcode") return method;
  throw new PaymentError(
    "VALIDATION",
    `${MESSAGE_PREFIX} 僅支援 atm / cvs / barcode（收到 "${method ?? "undefined"}"）；` +
      "信用卡請改用幕後授權 BackAuth",
    PROVIDER,
  );
}

function resolveExpireDate(method: EcpayPayCodeMethod, value: number | undefined): number {
  const rule = EXPIRE_RULES[method];
  if (value === undefined) return rule.default;
  if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} ${CHOOSE_PAYMENT[method]} expireDate 需為 ` +
        `${rule.min}-${rule.max} ${rule.unit}的整數（收到 ${value}）`,
      PROVIDER,
    );
  }
  return value;
}

function buildMethodInfo(
  method: EcpayPayCodeMethod,
  expireDate: number,
  input: EcpayPayCodeFields,
): Record<string, unknown> {
  switch (method) {
    case "atm":
      // ATMBankCode is documented 必填 even though an empty value is legal and
      // means "ECPay's default bank" — always send the key.
      return { ATMInfo: { ExpireDate: expireDate, ATMBankCode: input.atmBankCode ?? "" } };
    case "cvs":
      return {
        CVSInfo: {
          ExpireDate: expireDate,
          CVSCode: input.cvsChain ?? "CVS",
          ...cvsDescriptions(input.cvsDescriptions),
        },
      };
    case "barcode":
      return { BarcodeInfo: { ExpireDate: expireDate } };
  }
}

/** `Desc_1`…`Desc_4` — only rendered on FAMILY / IBON kiosks. */
function cvsDescriptions(descriptions: readonly string[] | undefined): Record<string, string> {
  if (!descriptions?.length) return {};
  if (descriptions.length > 4) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} CVS cvsDescriptions 最多 4 行（收到 ${descriptions.length}）`,
      PROVIDER,
    );
  }
  return Object.fromEntries(descriptions.map((desc, i) => [`Desc_${i + 1}`, desc]));
}

/**
 * Live 取號 answers `RtnCode: 1`. `2` (ATM 取號成功) and `10100073` (CVS/BARCODE
 * 取號成功) come from ECPay's shared code table, where they mark a *successful*
 * 取號 awaiting payment — accepted defensively so a gateway that ever returns one
 * is not reported as a failure.
 *
 * @see https://developers.ecpay.com.tw/28032
 */
const TAKE_NUMBER_OK = new Set([1, 2, 10_100_073]);

/**
 * Business-level RtnCode → normalized error code. ECPay publishes no complete
 * table (廠商後台 → 系統設定 → 交易狀態代碼查詢 holds the live list), so unmapped codes
 * fall through to PROVIDER with the raw code and message preserved.
 *
 * The first two were observed live on ecpayment-stage and are **not** the codes
 * the AIO table would suggest (`10200047` there means duplicate order); the rest
 * come from ECPay's cross-service table and are unverified on this endpoint.
 *
 * @see paycode-fixtures.ts for the recorded payloads
 */
const RTN_ERRORS: Record<string, { code: PaymentErrorCode; message: string }> = {
  "10300028": { code: "CONFLICT", message: "MerchantTradeNo 重複" }, // verified 2026-08-01
  "10000185": { code: "NOT_FOUND", message: "查無交易資料" }, // verified 2026-08-01
  "10100001": { code: "CONFLICT", message: "超商代碼已失效" },
  "10100058": { code: "CONFLICT", message: "ATM 繳費期限已過" },
  "10200009": { code: "CONFLICT", message: "訂單已過期" },
  "10200050": { code: "VALIDATION", message: "TotalAmount 超出範圍" },
  "10200095": { code: "CONFLICT", message: "交易已付款" },
};

function assertRtnOk(decoded: Record<string, unknown>, label: string): void {
  const rtnCode = Number(decoded.RtnCode);
  if (TAKE_NUMBER_OK.has(rtnCode)) return;

  const rawCode = str(decoded.RtnCode) || undefined;
  const rtnMsg = str(decoded.RtnMsg);
  const mapped = rawCode ? RTN_ERRORS[rawCode] : undefined;
  // Keep ECPay's own wording — it is more specific than our label, and the labels
  // exist mainly to pick the normalized code.
  const detail = [mapped?.message, rtnMsg].filter(Boolean).join(" / ") || "未知錯誤";
  throw new PaymentError(
    mapped?.code ?? "PROVIDER",
    `${MESSAGE_PREFIX} ${label} 失敗 (RtnCode=${rawCode ?? "?"}): ${detail}`,
    PROVIDER,
    { rawCode, rawMessage: rtnMsg || mapped?.message, raw: decoded },
  );
}

/**
 * Read a GenPaymentCode / QueryPaymentInfo payload. `method` is only a hint for
 * labelling — the actual code comes from whichever Info object ECPay filled, since
 * QueryPaymentInfo can return all three keys with the unused ones blank.
 */
function normalizePayCode(
  decoded: Record<string, unknown>,
  method?: EcpayPayCodeMethod,
): EcpayPayCodeResult {
  const orderInfo = asRecord(decoded.OrderInfo);
  const atmInfo = asRecord(decoded.ATMInfo);
  const cvsInfo = asRecord(decoded.CVSInfo);
  const barcodeInfo = asRecord(decoded.BarcodeInfo);

  const atm = str(atmInfo.vAccount)
    ? {
        bankCode: str(atmInfo.BankCode) || undefined,
        vAccount: str(atmInfo.vAccount),
        expireDate: str(atmInfo.ExpireDate) || undefined,
      }
    : undefined;
  const cvs = str(cvsInfo.PaymentNo)
    ? {
        paymentNo: str(cvsInfo.PaymentNo),
        expireDate: str(cvsInfo.ExpireDate) || undefined,
        paymentUrl: str(cvsInfo.PaymentURL) || undefined,
      }
    : undefined;
  const barcode = str(barcodeInfo.Barcode1)
    ? {
        barcode1: str(barcodeInfo.Barcode1),
        barcode2: str(barcodeInfo.Barcode2) || undefined,
        barcode3: str(barcodeInfo.Barcode3) || undefined,
        expireDate: str(barcodeInfo.ExpireDate) || undefined,
      }
    : undefined;

  const rtnCode = Number(decoded.RtnCode);
  const resolvedMethod =
    method ??
    payCodeMethodFromPaymentType(str(orderInfo.PaymentType)) ??
    (atm ? "atm" : cvs ? "cvs" : "barcode");

  return {
    mode: "paycode",
    method: resolvedMethod,
    merTradeNo: str(orderInfo.MerchantTradeNo),
    tradeNo: str(orderInfo.TradeNo) || undefined,
    amount: asNumber(orderInfo.TradeAmt),
    status: mapTradeStatus(str(orderInfo.TradeStatus)),
    tradeDate: str(orderInfo.TradeDate) || undefined,
    paidAt: str(orderInfo.PaymentDate) || undefined,
    chargeFee: asNumber(orderInfo.ChargeFee),
    rtnCode: Number.isFinite(rtnCode) ? rtnCode : -1,
    rtnMsg: str(decoded.RtnMsg),
    expireDate: atm?.expireDate ?? cvs?.expireDate ?? barcode?.expireDate,
    atm,
    cvs,
    barcode,
    customField: str(decoded.CustomField) || undefined,
    raw: decoded,
  };
}

function hasCode(result: EcpayPayCodeResult): boolean {
  return Boolean(result.atm ?? result.cvs ?? result.barcode);
}

function payCodeMethodFromPaymentType(value: string): EcpayPayCodeMethod | undefined {
  switch (value.toUpperCase().split("_")[0]) {
    case "ATM":
      return "atm";
    case "CVS":
      return "cvs";
    case "BARCODE":
      return "barcode";
    default:
      return undefined;
  }
}

function requireMerTradeNo(input: GetPaymentRequest): string {
  if (!input.merTradeNo) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} 查詢需要 MerchantTradeNo（--id）；此 API 不支援用 TradeNo 查詢`,
      PROVIDER,
    );
  }
  return input.merTradeNo;
}

function requireCredentials(config: EcpayPayCodeProviderConfig) {
  const { merchantId, hashKey, hashIv } = config;
  if (!merchantId || !hashKey || !hashIv) {
    throw new PaymentError(
      "AUTH",
      "缺少 ECPay 幕後取號憑證（MerchantID / HashKey / HashIV）",
      PROVIDER,
    );
  }
  return { merchantId, hashKey, hashIv };
}

/**
 * TradeStatus for a real order: `0` = 訂單成立未付款, `1` = 已付款. Anything else is
 * returned as-is (`"unknown"` when absent) rather than forced into the two known
 * states — see {@link EcpayPayCodeResult.status}.
 */
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

function mapPaymentType(value: string): string {
  if (!value) return "unknown";
  return payCodeMethodFromPaymentType(value) ?? value;
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

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}
