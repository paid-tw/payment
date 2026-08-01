/**
 * 中租零卡分期 result codes and order states, mapped to normalized `PaymentError` codes.
 *
 * Sources are marked per entry: `manual` for codes in 1.1.14's table (p.34-35), and
 * `recorded` for codes the API really returns that the table omits.
 */
import type { PaymentErrorCode } from "@paid-tw/payment";

export interface ZingalaResultMeta {
  /** Normalized code a caller can branch on. */
  code: PaymentErrorCode;
  /** 中租's own description, for the error message. */
  label: string;
  /** Where this entry comes from. `recorded` means the manual does not list it. */
  source: "manual" | "recorded";
}

/**
 * `result` codes. Manual 1.1.14 p.34-35 lists 000, 100-113, 199, 200-202, 300-303, 900,
 * 999 — and nothing in the 8xx range.
 */
export const ZINGALA_RESULT_CODES: Record<string, ZingalaResultMeta> = {
  "000": { code: "PROVIDER", label: "成功", source: "manual" }, // never surfaced as an error
  "100": { code: "NOT_FOUND", label: "訂單不存在", source: "manual" },
  "101": { code: "CONFLICT", label: "此訂單編號已重複", source: "manual" },
  "102": { code: "CONFLICT", label: "此訂單編號已交易", source: "manual" },
  "103": { code: "CONFLICT", label: "此訂單未獲授權", source: "manual" },
  "104": { code: "UNSUPPORTED", label: "訂單無法部分取消", source: "manual" },
  "105": { code: "CONFLICT", label: "此訂單已申請過全額退款", source: "manual" },
  "106": { code: "VALIDATION", label: "退款金額高於交易金額", source: "manual" },
  "107": { code: "CONFLICT", label: "此訂單已請款", source: "manual" },
  // A decline, not a state conflict. Matches how the ECPay adapters map 拒絕交易
  // (10100248) and 額度不足 (10100252) — see the DECLINED note below.
  "108": { code: "PROVIDER", label: "此訂單審核為婉拒", source: "manual" },
  "109": { code: "CONFLICT", label: "此訂單尚在審核程序中", source: "manual" },
  "110": { code: "VALIDATION", label: "請款金額訂單金額不符", source: "manual" },
  "111": { code: "CONFLICT", label: "訂單已超過可退款時間", source: "manual" },
  // 112 / 199 / 900 are the genuinely transient ones — 中租 tells you to retry later.
  "112": { code: "PROVIDER", label: "訂單部份取消資料處理中，請隔日或稍後再試", source: "manual" },
  "113": {
    code: "VALIDATION",
    label: "訂單部份取消剩餘金額低於訂單最低交易金額",
    source: "manual",
  },
  "199": {
    code: "PROVIDER",
    label: "此訂單已核准但尚有資料待補建檔，請隔日或稍後再試",
    source: "manual",
  },
  "200": { code: "VALIDATION", label: "參數錯誤", source: "manual" },
  "201": { code: "VALIDATION", label: "驗證錯誤", source: "manual" },
  "202": { code: "NOT_FOUND", label: "查無相關的文審要件資料", source: "manual" },
  "300": { code: "PROVIDER", label: "額度不足", source: "manual" },
  "301": { code: "CONFLICT", label: "訂單已逾時且未有結果", source: "manual" },
  "302": {
    code: "CONFLICT",
    label: "消費者已在 payment_url 進行操作，轉專人審核中",
    source: "manual",
  },
  "303": {
    code: "CONFLICT",
    label: "申請人 ID 與商家指定訂購人 ID 不同，訂單取消",
    source: "manual",
  },
  /**
   * ⚠️ **Not in the manual at all**, in any version up to 1.1.14. Recorded from UAT
   * 2026-08-02: `capture` on an order whose consumer has not confirmed yet, with a
   * *correct* amount, answers `801`. Anyone switching on the manual's table drops this
   * into their default branch.
   */
  "801": { code: "CONFLICT", label: "此案件消費者尚未確認交易", source: "recorded" },
  /**
   * The manual calls this 系統發生錯誤, which reads as "their side is broken" — but an
   * unrecognised enum lands here too: `fee_type: "bogus"` returns 900 (recorded
   * 2026-08-02), not 200. So it must **not** be treated as a retryable outage.
   */
  "900": { code: "PROVIDER", label: "系統發生錯誤（也可能是無效的參數值）", source: "manual" },
  "999": { code: "PROVIDER", label: "其他", source: "manual" },
};

/**
 * ⚠️ Core has no `DECLINED` / `REJECTED` code, so a credit decline (`300` 額度不足,
 * `108` 婉拒) normalizes to `PROVIDER` — the same choice the ECPay adapters make for
 * 10100248 / 10100252. That is consistent, but it does lose the one distinction a BNPL
 * caller most wants: "this consumer cannot borrow" is a business outcome to show the
 * shopper, not a gateway malfunction to retry or log. Worth adding to
 * `PaymentErrorCode` when the shared BNPL contract is designed; changing it here alone
 * would make this adapter disagree with the others.
 */

/** `result` values that mean success. */
export const ZINGALA_SUCCESS = "000";

/** Codes worth retrying — 中租 explicitly says 請隔日或稍後再試. */
export const ZINGALA_RETRYABLE = new Set(["112", "199"]);

/**
 * 訂單狀態代碼 `transaction_state`, from the inquiry API. Manual 1.1.14 p.35.
 *
 * This is an **underwriting** state machine, not an authorization one: the terminal
 * success is `005` 已撥款, which is days after approval. Do not read `003` as "paid".
 */
export const ZINGALA_TRANSACTION_STATES = {
  "001": { state: "pending-consumer", label: "消費者尚未在 payment_url 上進行操作" },
  "002": { state: "in-review", label: "此交易已轉專員審核處理中" },
  "003": { state: "approved", label: "交易已核准但尚未請款" },
  "004": { state: "capturing", label: "交易請款中" },
  "005": { state: "disbursed", label: "交易已撥款" },
  "006": { state: "declined", label: "交易失敗（婉拒）" },
  "007": { state: "cancelled", label: "交易在核准後通知取消或已全額退款" },
  "008": { state: "expired", label: "訂單在審核時取消或逾時取消" },
  "009": { state: "partial-cancelling", label: "部份取消資料處理中" },
} as const satisfies Record<string, { state: string; label: string }>;

export type ZingalaOrderState =
  | (typeof ZINGALA_TRANSACTION_STATES)[keyof typeof ZINGALA_TRANSACTION_STATES]["state"]
  | "unknown";

/** Map a raw `transaction_state` to a stable name. Unknown codes pass through as `unknown`. */
export function mapTransactionState(raw: string | null | undefined): ZingalaOrderState {
  if (!raw) return "unknown";
  const hit = ZINGALA_TRANSACTION_STATES[raw as keyof typeof ZINGALA_TRANSACTION_STATES];
  return hit ? hit.state : "unknown";
}

/** Human label for a `transaction_state`, or a marker naming the unknown code. */
export function describeTransactionState(raw: string | null | undefined): string {
  if (!raw) return "（無狀態碼）";
  const hit = ZINGALA_TRANSACTION_STATES[raw as keyof typeof ZINGALA_TRANSACTION_STATES];
  return hit ? hit.label : `未知狀態碼 ${raw}`;
}

/** States from which no further transition happens. */
export const ZINGALA_TERMINAL_STATES = new Set<ZingalaOrderState>([
  "disbursed",
  "declined",
  "cancelled",
  "expired",
]);

/**
 * Normalize a `result` code.
 *
 * `200 參數錯誤` carries the offending field after a colon — `參數錯誤 : product_name
 * 錯誤` (recorded) — so the caller's message keeps 中租's text rather than our generic
 * label, which would throw away the only clue about which field was wrong.
 */
export function describeResult(
  result: string,
  resultMessage?: string,
): ZingalaResultMeta & {
  message: string;
} {
  const meta = ZINGALA_RESULT_CODES[result] ?? {
    code: "PROVIDER" as PaymentErrorCode,
    label: "未知回應代碼",
    source: "recorded" as const,
  };
  const detail = resultMessage?.trim();
  return {
    ...meta,
    message: detail && detail !== meta.label ? `${meta.label} / ${detail}` : meta.label,
  };
}
