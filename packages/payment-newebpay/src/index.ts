// @paid-tw/payment-newebpay — NewebPay 藍新金流 MPG payment adapter.
export { createNewebpayProvider, NEWEBPAY_MPG_VERSION } from "./provider.js";
export type {
  NewebpayProvider,
  NewebpayCheckoutForm,
  NewebpayMpgFields,
  NewebpayCreatePaymentInput,
  NewebpayGetPaymentInput,
  NewebpayCreditActionInput,
  NewebpayCreditActionResult,
  NewebpayCancelAuthorizationResult,
  NewebpayRefundInput,
} from "./provider.js";
export { NEWEBPAY_ORIGINS, NEWEBPAY_PATHS, resolveNewebpayOrigin } from "./config.js";
export type { NewebpayProviderConfig } from "./config.js";
export {
  coerceNewebpayNotifyBody,
  mapNewebpayPaymentType,
  verifyNewebpayGetCodeNotify,
  verifyNewebpayPaymentNotify,
} from "./notify.js";
export type {
  NewebpayGetCodeNotify,
  NewebpayNotifyBody,
  NewebpayNotifyCredentials,
  NewebpayNotifyInput,
  NewebpayPaymentNotify,
} from "./notify.js";
export {
  buildQuery,
  checkCode,
  checkValue,
  decryptTradeInfo,
  encryptTradeInfo,
  tradeSha,
} from "./crypto.js";
export { NEWEBPAY_ERROR_MESSAGES, mapNewebpayErrorCode, newebpayErrorMessage } from "./codes.js";

// 信用卡定期定額 — separate factory / name "newebpay-period". Takes no card data
// (the consumer types the card on NewebPay's hosted page), so it lives on the
// root entry, unlike ecpay's raw-PAN backauth subpath.
export { createNewebpayPeriodProvider, NEWEBPAY_PERIOD_VERSIONS } from "./period/provider.js";
export type {
  NewebpayPeriodProvider,
  NewebpayPeriodType,
  NewebpayPeriodAlterType,
  NewebpayPeriodCreateInput,
  NewebpayPeriodCheckoutForm,
  NewebpayPeriodAlterStatusInput,
  NewebpayPeriodAlterStatusResult,
  NewebpayPeriodAlterAmtInput,
  NewebpayPeriodAlterAmtResult,
} from "./period/provider.js";
export { verifyPeriodCreateNotify, verifyPeriodCycleNotify } from "./period/notify.js";
export type { NewebpayPeriodCreateNotify, NewebpayPeriodCycleNotify } from "./period/notify.js";
