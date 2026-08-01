/**
 * `@paid-tw/payment-zingala` — 中租零卡分期 (Zingala) BNPL.
 *
 * ⚠️ **This is not a `PaymentProvider`.** BNPL is an underwriting flow, not an
 * authorization: `reserve_ec` opens a credit application, the outcome arrives
 * asynchronously after 專人審核, and the terminal success is 撥款 (disbursement) days
 * later — not "paid". Forcing it into `createPayment`/`getPayment` would make `status`
 * lie about what happened.
 *
 * A shared `BnplProvider` contract across 中租 / AFTEE / oppay is the goal, but it is
 * deliberately **not** defined yet: with one recorded provider, any "generic" interface
 * would just be this one wearing generic names. Zingala-specific shapes to watch when
 * that contract is designed — `comfirm_url` (中租 asks *us* whether the order is still
 * valid), `fee_type` vendor/consumer, and the 期數利率 table.
 */
export {
  isZingalaSandbox,
  resolveZingalaOrigin,
  ZINGALA_ORIGINS,
  ZINGALA_PATHS,
} from "./config.js";
export type { ZingalaConfig, ZingalaFeeBearer, ZingalaPath } from "./config.js";

export {
  computeDigest,
  decryptCustomerInfo,
  encryptCustomerInfo,
  phpUrlEncode,
  verifyDigest,
} from "./crypto.js";
export type { ZingalaCustomerInfo } from "./crypto.js";

export {
  describeResult,
  describeTransactionState,
  mapTransactionState,
  ZINGALA_RESULT_CODES,
  ZINGALA_RETRYABLE,
  ZINGALA_SUCCESS,
  ZINGALA_TERMINAL_STATES,
  ZINGALA_TRANSACTION_STATES,
} from "./codes.js";
export type { ZingalaOrderState, ZingalaResultMeta } from "./codes.js";

export { availablePeriods, calculateInstalmentPlan, findFeeOption } from "./fee.js";
export type { ZingalaFeeOption, ZingalaFeeSchedule, ZingalaInstalmentPlan } from "./fee.js";
