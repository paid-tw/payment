/**
 * The 中租零卡分期 client surface.
 *
 * Named for what it is — a BNPL application client, not a `PaymentProvider`. Method names
 * follow the underwriting flow (`applyInstallment` opens a credit application) rather than
 * payment vocabulary, so nothing here implies an authorization happened.
 */
import { PaymentError } from "@paid-tw/payment";
import { zingalaPost, zingalaPostForBytes, type ZingalaRequestOptions } from "./client.js";
import { describeTransactionState, mapTransactionState, type ZingalaOrderState } from "./codes.js";
import { type ZingalaConfig, type ZingalaFeeBearer, ZINGALA_PATHS } from "./config.js";
import { decryptCustomerInfo, type ZingalaCustomerInfo } from "./crypto.js";
import type { ZingalaFeeOption, ZingalaFeeSchedule } from "./fee.js";

const PROVIDER = "zingala";
const MESSAGE_PREFIX = "中租零卡分期";

/** 最長 30 天, per manual 1.1.14. */
const MAX_VALID_DAYS = 30;

export interface ZingalaApplyInput {
  /** 訂單編號. Merchant-defined and must be unique — see the replay warning below. */
  orderId: string;
  /**
   * 商品名稱. 中租 scores the application partly on this, so a placeholder lowers the
   * approval rate — the manual is explicit that a missing real product name hurts.
   */
  productName: string;
  /** 交易金額. Integer TWD. */
  amount: number;
  /** 分期期數. `1` means 一次付清. Check {@link ZingalaClient.getFeeSchedule} first. */
  periods: number;
  /** 手續費負擔對象. `vendor` = 零利率, `consumer` = 利息外加. */
  feeBearer: ZingalaFeeBearer;
  /** 審核結果通知網址 — where 中租 posts the outcome. */
  notifyUrl: string;
  /** 確認訂單效用網址 — 中租 asks whether the order is still valid. Optional. */
  confirmUrl?: string;
  /** 交易結果頁面 — where the consumer lands afterwards. Optional. */
  displayUrl?: string;
  /** `payment_url` validity in days, 1-30. */
  validDays: number;
  /** Auto-capture on approval. `false` (the default) means you must call `capture`. */
  autoCapture?: boolean;
  /** Receive 申請人 name/phone on the notify. Defaults to on, matching 中租. */
  receiveCustomerInfo?: boolean;
  /** 子商店代號. */
  storeId?: string;
  /** 備註商店名稱, for the merchant's own reporting. */
  storeName?: string;
  /** 會員資料 — raises the approval rate, and pins who may complete the application. */
  buyer?: {
    /** 會員身分證字號. When set, only this person's application is accepted. */
    specificId?: string;
    email?: string;
    shippingAddress?: string;
    /** 帳號註冊是否滿 30 天. */
    accountOlderThan30Days?: boolean;
    /** 最近一次訂單成立日, `YYYY-MM-DD`. */
    lastOrderDate?: string;
    lastOrderAmount?: number;
  };
}

export interface ZingalaApplication {
  orderId: string;
  /** 付款連結 (web). Send the consumer here. */
  paymentUrlWeb: string;
  /**
   * 付款連結 (app).
   *
   * Recorded 2026-08-02: identical to {@link paymentUrlWeb}. The manual treats them as
   * separate, and revision 1.1.0 even claimed the app link was removed, but UAT returns
   * both with the same value. Kept distinct in case production differs.
   */
  paymentUrlApp?: string;
  /** 截止時間 — after this the application expires and the notify reports a cancel. */
  expiresAt?: string;
  raw: Record<string, unknown>;
}

export interface ZingalaOrder {
  orderId: string;
  /** 仲信送件編號 `spanapp_id` — 中租's own id for the case. */
  caseId?: string;
  state: ZingalaOrderState;
  /** The raw `transaction_state`, kept so an unmapped code is still visible. */
  rawState?: string;
  /** Human-readable state, naming the code when it is unrecognised. */
  stateLabel: string;
  amount?: number;
  periods?: number;
  feeBearer?: string;
  productName?: string;
  /** 交易歸屬商店 — `store_id` or `store_name`, whichever 中租 recorded. */
  store?: string;
  /** 預約交易受理日 `YYYYMMDD`. */
  reservedOn?: string;
  /** 審核結果通知日 `YYYYMMDD`. Null until a notify was sent. */
  notifiedOn?: string;
  /** 核准授權日. Only present for states 003 / 004 / 005. */
  authorizedAt?: string;
  /** 審查完成時間. With state 002 this means "processed, awaiting approval". */
  reviewCompletedAt?: string;
  /** 交易授權過期日 — capture must happen before this. */
  captureDeadline?: string;
  /** 撥款日期. Only once the state reaches 005. */
  disbursedOn?: string;
  /** 契約編號. */
  contractNumber?: string;
  /** Whether 審核通知函 can be downloaded (manual 1.1.6). */
  approvalNoticeAvailable: boolean;
  /** 申請人資料, decrypted. `undefined` when 中租 sent none. */
  customer?: ZingalaCustomerInfo;
  refunds: {
    refundId?: string;
    requestedAt?: string;
    amount?: number;
    remainingAmount?: number;
  }[];
  /** 案件歷程. */
  history: { note?: string; updatedAt?: string }[];
  raw: Record<string, unknown>;
}

export interface ZingalaCaptureResult {
  orderId: string;
  amount?: number;
  periods?: number;
  feeBearer?: string;
  /** 財顧管理費. */
  advisoryFee?: number;
  store?: string;
  raw: Record<string, unknown>;
}

export interface ZingalaRefundResult {
  /** 退款編號. String since manual 1.1.8 — it was documented as Int before. */
  refundId?: string;
  requestedAt?: string;
  /** 原始交易金額. */
  originalAmount?: number;
  /** 此次申請退款金額. */
  refundedAmount?: number;
  /** 退款後剩餘金額. */
  remainingAmount?: number;
  /** 已繳清狀態. */
  paidUp?: boolean;
  advisoryFee?: number;
  raw: Record<string, unknown>;
}

export interface ZingalaMemberCheck {
  /** Whether the ID has 零卡分期 credit available. */
  isMember: boolean;
  /**
   * 立即申請網址, returned when {@link isMember} is false.
   *
   * ⚠️ Contains the merchant id as a `COMPID` query parameter.
   */
  signupUrl?: string;
  raw: Record<string, unknown>;
}

export interface ZingalaBank {
  code: string;
  name: string;
  branches: { code: string; name: string }[];
}

export interface ZingalaClient {
  readonly name: "zingala";
  /** 預約交易 — opens a credit application and returns the consumer's URL. */
  applyInstallment(
    input: ZingalaApplyInput,
    options?: ZingalaRequestOptions,
  ): Promise<ZingalaApplication>;
  /** 查詢交易 — batch, up to 100 ids. */
  getOrders(
    input: { orderIds?: string[]; caseIds?: string[] },
    options?: ZingalaRequestOptions,
  ): Promise<ZingalaOrder[]>;
  /** One order, or a NOT_FOUND error. See the empty-array trap in the implementation. */
  getOrder(orderId: string, options?: ZingalaRequestOptions): Promise<ZingalaOrder>;
  /** 手動請款. No partial capture — the amount must equal the order's. */
  capture(
    input: { orderId: string; amount: number },
    options?: ZingalaRequestOptions,
  ): Promise<ZingalaCaptureResult>;
  /** 取消交易 / 退款. */
  refund(
    input: { orderId: string; refundAmount: number },
    options?: ZingalaRequestOptions,
  ): Promise<ZingalaRefundResult>;
  /** 檢核是否為零卡會員. */
  checkMember(custId: string, options?: ZingalaRequestOptions): Promise<ZingalaMemberCheck>;
  /** 查詢期數利率. */
  getFeeSchedule(options?: ZingalaRequestOptions): Promise<ZingalaFeeSchedule>;
  /** 取得金融機構代碼表. */
  getBankBranches(options?: ZingalaRequestOptions): Promise<ZingalaBank[]>;
  /** 下載審核通知函 (PDF bytes). Check `approvalNoticeAvailable` first. */
  downloadApprovalNotice(orderId: string, options?: ZingalaRequestOptions): Promise<Uint8Array>;
}

export function createZingalaClient(config: ZingalaConfig): ZingalaClient {
  return {
    name: PROVIDER,

    async applyInstallment(input, options) {
      assertApplyInput(input);
      const { data } = await zingalaPost(
        config,
        ZINGALA_PATHS.reserveEc,
        {
          order_id: input.orderId,
          product_name: input.productName,
          amount: Math.round(input.amount),
          installment: input.periods,
          fee_type: input.feeBearer,
          notify_url: input.notifyUrl,
          valid_days: input.validDays,
          ...(input.confirmUrl ? { comfirm_url: input.confirmUrl } : {}), // 中租's spelling
          ...(input.displayUrl ? { display_url: input.displayUrl } : {}),
          ...(input.autoCapture === undefined ? {} : { capture: input.autoCapture }),
          ...(input.receiveCustomerInfo === undefined
            ? {}
            : { customer_info: input.receiveCustomerInfo ? "1" : "0" }),
          ...(input.storeId ? { store_id: input.storeId } : {}),
          ...(input.storeName ? { store_name: input.storeName } : {}),
          ...(input.buyer ? { buyer_data: buildBuyerData(input.buyer) } : {}),
        },
        "reserve_ec",
        options,
      );

      const reserve = asRecord(data.info_reserve);
      const web = text(reserve.payment_url_web);
      if (!web) {
        // result was 000 but there is no link — nothing sensible to do with that.
        throw new PaymentError(
          "PROVIDER",
          `${MESSAGE_PREFIX} reserve_ec 回應成功卻沒有 payment_url_web`,
          PROVIDER,
          { raw: data },
        );
      }
      return {
        orderId: input.orderId,
        paymentUrlWeb: web,
        paymentUrlApp: text(reserve.payment_url_app),
        expiresAt: text(reserve.expire_date),
        raw: data,
      };
    },

    async getOrders(input, options) {
      const orderIds = input.orderIds ?? [];
      const caseIds = input.caseIds ?? [];
      if (orderIds.length === 0 && caseIds.length === 0) {
        throw new PaymentError(
          "VALIDATION",
          `${MESSAGE_PREFIX} 查詢需要 orderIds 或 caseIds 至少一項`,
          PROVIDER,
        );
      }
      if (orderIds.length > 100 || caseIds.length > 100) {
        throw new PaymentError(
          "VALIDATION",
          `${MESSAGE_PREFIX} 查詢一次最多 100 筆（收到 order=${orderIds.length} case=${caseIds.length}）`,
          PROVIDER,
        );
      }

      const { data } = await zingalaPost(
        config,
        ZINGALA_PATHS.inquiry,
        {
          // Both keys must be present; 中租 wants an empty array, not a missing field.
          order_id_list: orderIds.map((id) => ({ id })),
          spanapp_id_list: caseIds.map((id) => ({ id })),
        },
        "inquiry",
        options,
      );

      const rows = Array.isArray(data.info) ? (data.info as unknown[]) : [];
      return rows.map((row) => normalizeOrder(asRecord(row), config));
    },

    async getOrder(orderId, options) {
      const [order] = await this.getOrders({ orderIds: [orderId] }, options);
      if (!order) {
        // ⚠️ Recorded: an unknown order answers `result: "000"` with `info: []`, i.e.
        // success. Without this the caller gets `undefined` for a missing order and only
        // notices further downstream.
        throw new PaymentError(
          "NOT_FOUND",
          `${MESSAGE_PREFIX} 查無訂單 ${orderId}（inquiry 回 result=000 但 info 為空陣列）`,
          PROVIDER,
        );
      }
      return order;
    },

    async capture(input, options) {
      if (!input.orderId) {
        throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} 請款需要 orderId`, PROVIDER);
      }
      const { data } = await zingalaPost(
        config,
        ZINGALA_PATHS.capture,
        { order_id: input.orderId, amount: Math.round(input.amount) },
        "capture",
        options,
      );
      const info = asRecord(data.info_order);
      return {
        orderId: text(info.order_id) ?? input.orderId,
        amount: num(info.amount),
        periods: num(info.installment),
        feeBearer: text(info.fee_type),
        advisoryFee: num(info.fn_ma),
        store: text(info.store),
        raw: data,
      };
    },

    async refund(input, options) {
      if (!input.orderId) {
        throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} 退款需要 orderId`, PROVIDER);
      }
      const { data } = await zingalaPost(
        config,
        ZINGALA_PATHS.refund,
        { order_id: input.orderId, refund_amount: Math.round(input.refundAmount) },
        "refund",
        options,
      );
      const info = asRecord(data.info_refund);
      return {
        // String since manual 1.1.8; coerced rather than trusted so an older
        // numeric-shaped response still normalizes.
        refundId: text(info.refund_id),
        requestedAt: text(info.refund_time),
        originalAmount: num(info.amount),
        refundedAmount: num(info.refund_amount),
        remainingAmount: num(info.final_amount),
        paidUp: typeof info.pay_up === "boolean" ? info.pay_up : undefined,
        advisoryFee: num(info.fn_ma),
        raw: data,
      };
    },

    async checkMember(custId, options) {
      if (!custId) {
        throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} 需要 cust_id`, PROVIDER);
      }
      const { data } = await zingalaPost(
        config,
        ZINGALA_PATHS.checkIsMember,
        { cust_id: custId },
        "check_is_member",
        options,
      );
      return {
        isMember: text(data.is_member) === "Y",
        signupUrl: text(data.recommend_member_url),
        raw: data,
      };
    },

    async getFeeSchedule(options) {
      const { data } = await zingalaPost(config, ZINGALA_PATHS.getFee, {}, "get_fee", options);
      return {
        vendorBorne: normalizeFeeList(data.vendor_fee_list),
        consumerBorne: normalizeFeeList(data.consumer_fee_list),
      };
    },

    async getBankBranches(options) {
      const { data } = await zingalaPost(
        config,
        ZINGALA_PATHS.getBankBranch,
        {},
        "get_bank_branch",
        options,
      );
      const banks = Array.isArray(data.bank) ? (data.bank as unknown[]) : [];
      return banks.map((entry) => {
        const b = asRecord(entry);
        const branches = Array.isArray(b.brnch) ? (b.brnch as unknown[]) : [];
        return {
          code: text(b.bnk_id) ?? "",
          name: text(b.bnk_nme) ?? "",
          branches: branches.map((br) => {
            const r = asRecord(br);
            return { code: text(r.brnch_id) ?? "", name: text(r.brnch_nme) ?? "" };
          }),
        };
      });
    },

    async downloadApprovalNotice(orderId, options) {
      if (!orderId) {
        throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} 需要 orderId`, PROVIDER);
      }
      return zingalaPostForBytes(
        config,
        ZINGALA_PATHS.downloadApprovalNotice,
        { order_id: orderId },
        "download_aprvnotice_pdf",
        options,
      );
    },
  };
}

function assertApplyInput(input: ZingalaApplyInput): void {
  if (!input.orderId) {
    throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} 需要 orderId`, PROVIDER);
  }
  if (!input.productName) {
    // Not merely required: 中租 scores the application on it.
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} 需要 productName（零卡分期會用商品名稱評分，帶假名稱會降低核准率）`,
      PROVIDER,
    );
  }
  if (!Number.isInteger(input.amount) || input.amount < 1) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} amount 必須是 >= 1 的整數（收到 ${String(input.amount)}）`,
      PROVIDER,
    );
  }
  if (!Number.isInteger(input.periods) || input.periods < 1) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} periods 必須是 >= 1 的整數（收到 ${String(input.periods)}）`,
      PROVIDER,
    );
  }
  if (input.feeBearer !== "vendor" && input.feeBearer !== "consumer") {
    // Sending an unknown value answers `900 系統發生錯誤`, which reads as an outage —
    // rejecting locally keeps that confusion out of the caller's logs.
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} feeBearer 需為 vendor 或 consumer（收到 "${String(input.feeBearer)}"）`,
      PROVIDER,
    );
  }
  if (!input.notifyUrl) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} 需要 notifyUrl，否則審核結果無處可送`,
      PROVIDER,
    );
  }
  if (
    !Number.isInteger(input.validDays) ||
    input.validDays < 1 ||
    input.validDays > MAX_VALID_DAYS
  ) {
    throw new PaymentError(
      "VALIDATION",
      `${MESSAGE_PREFIX} validDays 需為 1-${MAX_VALID_DAYS}（收到 ${String(input.validDays)}）`,
      PROVIDER,
    );
  }
}

function buildBuyerData(buyer: NonNullable<ZingalaApplyInput["buyer"]>): Record<string, unknown> {
  return {
    ...(buyer.specificId ? { specific_id: buyer.specificId } : {}),
    ...(buyer.email ? { email: buyer.email } : {}),
    ...(buyer.shippingAddress ? { shipping_address: buyer.shippingAddress } : {}),
    ...(buyer.accountOlderThan30Days === undefined
      ? {}
      : { account_age: buyer.accountOlderThan30Days }),
    ...(buyer.lastOrderDate ? { last_order_date: buyer.lastOrderDate } : {}),
    ...(buyer.lastOrderAmount === undefined ? {} : { last_order_amount: buyer.lastOrderAmount }),
  };
}

function normalizeFeeList(input: unknown): ZingalaFeeOption[] {
  // `null` is 中租's way of saying "this merchant has no such arrangement" — the real
  // meaning behind `201 無配合費率外加(低利率)報價`.
  if (!Array.isArray(input)) return [];
  return (input as unknown[])
    .map((row) => {
      const r = asRecord(row);
      return { periods: num(r.prd_num) ?? 0, feeRate: num(r.fee_rate) ?? 0 };
    })
    .filter((o) => o.periods > 0);
}

function normalizeOrder(row: Record<string, unknown>, config: ZingalaConfig): ZingalaOrder {
  const rawState = text(row.transaction_state);
  const refunds = Array.isArray(row.refundlist) ? (row.refundlist as unknown[]) : [];
  const history = Array.isArray(row.case_record_list) ? (row.case_record_list as unknown[]) : [];

  return {
    orderId: text(row.order_id) ?? "",
    caseId: text(row.spanapp_id),
    state: mapTransactionState(rawState),
    rawState,
    stateLabel: describeTransactionState(rawState),
    amount: num(row.amount),
    periods: num(row.installment),
    feeBearer: text(row.fee_type),
    productName: text(row.product_name),
    store: text(row.store),
    reservedOn: text(row.reserve_date),
    notifiedOn: text(row.transacting_date),
    authorizedAt: text(row.auth_day),
    reviewCompletedAt: text(row.crd_cmptl_dt),
    captureDeadline: text(row.authorize_expire),
    disbursedOn: text(row.disburse_date),
    contractNumber: text(row.contract_number),
    approvalNoticeAvailable: text(row.download_aprvnotice_pdf) === "Y",
    customer: decryptCustomerInfo(text(row.info_customer_json), config.aesKey, config.aesIv),
    refunds: refunds
      .map((entry) => {
        const r = asRecord(entry);
        return {
          refundId: text(r.refund_id),
          requestedAt: text(r.refund_time),
          amount: num(r.refund_amount),
          remainingAmount: num(r.final_amount),
        };
      })
      // 中租 always sends one all-null row when there are no refunds; dropping it means
      // `refunds.length` answers "has anything been refunded?" honestly.
      .filter((r) => r.refundId || r.requestedAt || (r.amount ?? 0) > 0),
    history: history.map((entry) => {
      const r = asRecord(entry);
      return { note: text(r.record_cnt), updatedAt: text(r.upd_dt) };
    }),
    raw: row,
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function text(input: unknown): string | undefined {
  if (typeof input === "string") return input || undefined;
  if (typeof input === "number" || typeof input === "bigint") return String(input);
  return undefined;
}

function num(input: unknown): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (typeof input === "string" && input.trim()) {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
