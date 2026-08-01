// @paid-tw/payment-ecpay — ECPay 綠界 All-in-One payment adapter.
export { createEcpayProvider, computeCheckMacValue } from "./provider.js";
export type {
  EcpayProvider,
  EcpayAioCommonFields,
  EcpayAioFields,
  EcpayCreatePaymentInput,
  EcpayTakeNumberHooks,
  EcpayCheckoutForm,
  EcpayRefundResult,
  EcpayCreditAction,
  EcpayCreditDoActionInput,
  EcpayCreditDoActionResult,
  EcpayCreditTradeQueryInput,
  EcpayCreditTradeDetail,
  EcpayCreditCloseRow,
} from "./provider.js";
export {
  ECPAY_ORIGINS,
  ECPAY_SANDBOX,
  ECPAY_SANDBOX_PORTAL,
  resolveEcpayOrigin,
} from "./config.js";
export type { EcpayProviderConfig } from "./config.js";
export {
  ECPAY_NOTIFY_ACK,
  coerceNotifyBody,
  verifyEcpayPaymentInfoNotify,
  verifyPaymentNotify,
} from "./notify.js";
export type {
  EcpayNotifyBody,
  EcpayNotifyCredentials,
  EcpayNotifyInput,
  EcpayPaymentInfoNotify,
  EcpayPaymentNotify,
} from "./notify.js";

// 站內付 2.0 (ECPG) — separate factory / name "ecpay-ecpg"
export { createEcpayEcpgProvider } from "./ecpg/provider.js";
export type {
  EcpayEcpgProvider,
  EcpgCreatePaymentInput,
  EcpgCreatePaymentResult,
  EcpgCreateWithPayTokenInput,
  EcpgConsumerFields,
  EcpgTokenResult,
} from "./ecpg/provider.js";
export { ECPG_ORIGINS, resolveEcpgOrigin } from "./ecpg/config.js";
export type { EcpgProviderConfig } from "./ecpg/config.js";
export { encryptData, decryptData, aesEncrypt, aesDecrypt } from "./ecpg/aes.js";
export { verifyEcpgPaymentNotify, ECPG_NOTIFY_ACK } from "./ecpg/notify.js";
export type {
  EcpgNotifyCredentials,
  EcpgNotifyEnvelope,
  EcpgPaymentNotify,
} from "./ecpg/notify.js";

// 非信用卡幕後取號 — separate factory / name "ecpay-paycode"
export { createEcpayPayCodeProvider, parseTradeMediaCsv } from "./paycode/provider.js";
export type {
  EcpayAtmCode,
  EcpayBarcodeCode,
  EcpayCvsBarcodeChain,
  EcpayCvsBarcodeInput,
  EcpayCvsBarcodeResult,
  EcpayCvsChain,
  EcpayCvsCode,
  EcpayPayCodeCreateInput,
  EcpayPayCodeFields,
  EcpayPayCodeMethod,
  EcpayPayCodeProvider,
  EcpayPayCodeResult,
  EcpayTradeMediaQuery,
  EcpayTradeMediaResult,
} from "./paycode/provider.js";
export {
  ECPAY_PAYCODE_ORIGINS,
  ECPAY_PAYCODE_PATHS,
  resolvePayCodeOrigin,
} from "./paycode/config.js";
export type { EcpayPayCodeProviderConfig } from "./paycode/config.js";
export { ECPAY_PAYCODE_NOTIFY_ACK, verifyEcpayPayCodeNotify } from "./paycode/notify.js";
export type {
  EcpayPayCodeNotify,
  EcpayPayCodeNotifyCredentials,
  EcpayPayCodeNotifyEnvelope,
} from "./paycode/notify.js";

// 信用卡查詢 — shared by 站內付 2.0 and 幕後授權, which document the same endpoints twice.
// Exported at the root because neither takes card data: 單筆明細 takes order ids, and
// 發卡行 takes a 6-9 digit BIN prefix.
export { queryEcpayCreditDetail, queryEcpayCardInfo } from "./credit/queries.js";
export type {
  EcpayCardInfoInput,
  EcpayCardIssuerInfo,
  EcpayCreditCloseRecord,
  EcpayCreditDetail,
  EcpayCreditDetailInput,
} from "./credit/queries.js";
export {
  ECPAY_CREDIT_ORIGINS,
  ECPAY_CREDIT_PATHS,
  ECPAY_SANDBOX_GATEWAY,
  resolveCreditOrigin,
} from "./credit/config.js";
export type { EcpayCreditQueryConfig } from "./credit/config.js";

// 信用卡幕後授權 (BackAuth) is deliberately **not** exported here.
//
// It is the only adapter that accepts a raw card number, and it lives behind its own
// subpath so an application can prove by import graph that it does not pull in a
// raw-PAN surface:
//
//   import { createEcpayBackAuthProvider } from "@paid-tw/payment-ecpay/backauth";
//
// PCI-DSS scope follows from *handling* card data, so not calling it keeps you in
// SAQ A either way — the split is what makes that mechanically checkable rather than
// a claim. Do not re-export it from here.
