/**
 * 中租零卡分期's two inbound calls — the ones **you** implement and 中租 calls.
 *
 * This is the part with no equivalent in the card adapters. A gateway notify tells you a
 * payment happened; 中租's `notify_url` tells you a credit application was approved, which
 * is your cue to ship goods. And `comfirm_url` is stranger still: 中租 asks *you* whether
 * the order is still valid, and stops the review if you say no.
 *
 * ⚠️ **Doc-derived, not recorded.** Neither call can be triggered from UAT without the
 * test consumer app and a human reviewer, so the shapes here follow manual 1.1.14 (p.11-13)
 * rather than a recording. Every other module in this package is backed by real payloads;
 * this one is the exception, and a recorded notify should replace the fixtures in
 * `__tests__/notify.test.ts` when one becomes available.
 */
import { timingSafeEqual } from "node:crypto";
import { PaymentError } from "@paid-tw/payment";
import { describeTransactionState, mapTransactionState, type ZingalaOrderState } from "./codes.js";
import { decryptCustomerInfo, verifyDigest, type ZingalaCustomerInfo } from "./crypto.js";

const PROVIDER = "zingala";
const MESSAGE_PREFIX = "中租零卡分期";

/**
 * What to answer a notify with: HTTP 200 and no body required.
 *
 * The manual states 「HTTP 200 (表示通知有送達)」 — the status *is* the acknowledgement, so
 * returning 200 with an error page still tells 中租 you accepted it.
 */
export const ZINGALA_NOTIFY_ACK = { status: 200 } as const;

/** The credentials needed to authenticate an inbound call. */
export interface ZingalaNotifyCredentials {
  /** Compared against the `0Card-API-Key` header 中租 sends back. */
  apiKey: string;
  /** Verifies the `Digest` header and decrypts 申請人資料. */
  aesKey: string;
  aesIv: string;
}

export interface ZingalaNotifyHeaders {
  /** HMAC-SHA256 of the raw request body, hex. */
  digest?: string | null;
  /** 中租 echoes the API key so you can authenticate the caller. */
  apiKey?: string | null;
}

export interface ZingalaNotifyOptions {
  /**
   * Skip the `Digest` check. **Do not use in production.** An unverified notify is an
   * instruction from an unauthenticated source to release goods on credit.
   */
  allowUnsignedNotify?: boolean;
  /** Skip the `0Card-API-Key` comparison. Same warning. */
  allowMissingApiKey?: boolean;
}

/** 審核結果通知 — one application's outcome. */
export interface ZingalaNotify {
  /** `result` from the notify body. `000` means the notify itself is well-formed. */
  result: string;
  resultMessage?: string;
  orderId: string;
  /** 仲信送件編號. */
  caseId?: string;
  state: ZingalaOrderState;
  rawState?: string;
  stateLabel: string;
  /**
   * Whether this outcome means "approved — you may ship".
   *
   * True only for 003 / 004 / 005. Note 004 and 005 are *later* stages of the same
   * approval, so they count; `approved` alone would miss a notify that arrives after
   * capture already started.
   */
  approved: boolean;
  /** Whether the application ended unsuccessfully (婉拒 / 取消 / 逾時). */
  failed: boolean;
  amount?: number;
  periods?: number;
  feeBearer?: string;
  /** 第一期付款金額, as 中租 computed it. Compare against `calculateInstalmentPlan`. */
  firstPayment?: number;
  /** 剩餘每期付款金額. */
  eachPayment?: number;
  /** 核准授權日. Present for 003 / 004 / 005. */
  authorizedAt?: string;
  /** 審查完成時間. */
  reviewCompletedAt?: string;
  /** 申請人資料, decrypted. `undefined` when `customer_info` was 0. */
  customer?: ZingalaCustomerInfo;
  /** The decoded body, verbatim. */
  data: Record<string, unknown>;
}

/**
 * Verify and normalize a 審核結果通知.
 *
 * Pass the **raw request body text**, not a parsed object: `Digest` signs the bytes, so a
 * re-serialized object cannot be verified (`JSON.stringify` reorders keys and drops
 * whitespace). Frameworks that parse eagerly need a raw-body capture — `express.raw()`,
 * Hono's `c.req.text()`, or Next's `await request.text()`.
 *
 * Idempotency: 中租 may deliver more than once, and the manual's own flow has the notify
 * fire again as the state advances (審核中 → 核准). Key on `orderId` **plus** the state, or
 * you will treat an approval as a replay of the earlier in-review notify.
 */
export function verifyZingalaNotify(
  rawBody: string,
  headers: ZingalaNotifyHeaders,
  credentials: ZingalaNotifyCredentials,
  options: ZingalaNotifyOptions = {},
): ZingalaNotify {
  if (typeof rawBody !== "string" || !rawBody.trim()) {
    throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} 通知內容是空的`, PROVIDER);
  }

  if (!options.allowMissingApiKey) {
    assertApiKey(headers.apiKey, credentials.apiKey);
  }

  if (!options.allowUnsignedNotify) {
    if (!headers.digest) {
      throw new PaymentError(
        "AUTH",
        `${MESSAGE_PREFIX} 通知沒有 Digest 簽章，無法確認來源`,
        PROVIDER,
      );
    }
    if (!verifyDigest(rawBody, headers.digest, credentials.aesKey)) {
      throw new PaymentError(
        "AUTH",
        `${MESSAGE_PREFIX} 通知 Digest 驗證失敗（內容可能被竄改，或 aesKey 不符）`,
        PROVIDER,
        { raw: { body: rawBody.slice(0, 400) } },
      );
    }
  }

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    data = parsed as Record<string, unknown>;
  } catch (cause) {
    throw new PaymentError("PROVIDER", `${MESSAGE_PREFIX} 通知不是 JSON 物件`, PROVIDER, {
      cause,
      raw: { body: rawBody.slice(0, 400) },
    });
  }

  const info = asRecord(data.info_order);
  const rawState = text(info.transaction_state);
  const state = mapTransactionState(rawState);

  return {
    result: text(data.result) ?? "",
    resultMessage: text(data.result_message),
    orderId: text(info.order_id) ?? "",
    caseId: text(info.spanapp_id),
    state,
    rawState,
    stateLabel: describeTransactionState(rawState),
    // 004/005 are stages after approval, so they must count as approved too.
    approved: state === "approved" || state === "capturing" || state === "disbursed",
    failed: state === "declined" || state === "cancelled" || state === "expired",
    amount: num(info.amount),
    periods: num(info.installment),
    feeBearer: text(info.fee_type),
    firstPayment: num(info.first_payment),
    eachPayment: num(info.each_payment),
    authorizedAt: text(info.auth_day),
    reviewCompletedAt: text(info.crd_cmptl_dt),
    customer: decryptCustomerInfo(
      text(data.info_customer_json),
      credentials.aesKey,
      credentials.aesIv,
    ),
    data,
  };
}

/** 確認訂單效用 — 中租 asking whether your order is still valid. */
export interface ZingalaConfirmRequest {
  orderId: string;
  data: Record<string, unknown>;
}

/**
 * Verify an inbound `comfirm_url` call and pull out the order id.
 *
 * ⚠️ This one carries **no `Digest`** — the manual lists only `0Card-API-Key` in its
 * request header table, so the API key is the sole authentication available. Treat the
 * answer as advisory-but-consequential: replying `false` (or, per the manual, anything
 * other than `false`... see {@link buildZingalaConfirmResponse}) stops 中租's review and
 * releases the consumer's reserved credit.
 */
export function verifyZingalaConfirmRequest(
  rawBody: string,
  headers: Pick<ZingalaNotifyHeaders, "apiKey">,
  credentials: Pick<ZingalaNotifyCredentials, "apiKey">,
  options: Pick<ZingalaNotifyOptions, "allowMissingApiKey"> = {},
): ZingalaConfirmRequest {
  if (!options.allowMissingApiKey) {
    assertApiKey(headers.apiKey, credentials.apiKey);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (cause) {
    throw new PaymentError("PROVIDER", `${MESSAGE_PREFIX} comfirm_url 內容不是 JSON`, PROVIDER, {
      cause,
    });
  }

  const orderId = text(data.order_id);
  if (!orderId) {
    throw new PaymentError("VALIDATION", `${MESSAGE_PREFIX} comfirm_url 缺少 order_id`, PROVIDER, {
      raw: data,
    });
  }
  return { orderId, data };
}

/**
 * The body to answer a `comfirm_url` call with.
 *
 * ⚠️ **Failing open is the documented behaviour**: 「若未回應 false，則代表皆為 true」. So a
 * crash, a timeout, or a 500 from your handler all read as "this order is still valid" and
 * the review proceeds. If your validity check can fail, decide deliberately whether that
 * should answer `false` — silence does not.
 */
export function buildZingalaConfirmResponse(valid: boolean): { valid: boolean } {
  return { valid };
}

function assertApiKey(received: string | null | undefined, expected: string): void {
  if (!received) {
    throw new PaymentError(
      "AUTH",
      `${MESSAGE_PREFIX} 缺少 0Card-API-Key header，無法確認呼叫來源`,
      PROVIDER,
    );
  }
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    throw new PaymentError("AUTH", `${MESSAGE_PREFIX} 0Card-API-Key 不符`, PROVIDER);
  }
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
