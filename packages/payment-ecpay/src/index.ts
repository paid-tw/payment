// @paid-tw/payment-ecpay — ECPay 綠界 All-in-One payment adapter.
export { createEcpayProvider, computeCheckMacValue } from "./provider.js";
export type {
  EcpayProvider,
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
export { ECPAY_NOTIFY_ACK, coerceNotifyBody, verifyPaymentNotify } from "./notify.js";
export type {
  EcpayNotifyBody,
  EcpayNotifyCredentials,
  EcpayNotifyInput,
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
export { createEcpayPayCodeProvider } from "./paycode/provider.js";
export type {
  EcpayAtmCode,
  EcpayBarcodeCode,
  EcpayCvsChain,
  EcpayCvsCode,
  EcpayPayCodeCreateInput,
  EcpayPayCodeFields,
  EcpayPayCodeMethod,
  EcpayPayCodeProvider,
  EcpayPayCodeResult,
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

// 信用卡幕後授權 (BackAuth) — separate factory / name "ecpay-backauth"
//
// ⚠️ This adapter accepts a raw card number, which puts the calling process in
// PCI-DSS SAQ D scope. The other three ECPay adapters never see card data.
export { createEcpayBackAuthProvider } from "./backauth/provider.js";
export type {
  EcpayAuthCardInfo,
  EcpayBackAuth3DSResult,
  EcpayBackAuthAction,
  EcpayBackAuthAuthorizedResult,
  EcpayBackAuthCreateInput,
  EcpayBackAuthDoActionInput,
  EcpayBackAuthDoActionResult,
  EcpayBackAuthFields,
  EcpayBackAuthProvider,
  EcpayBackAuthResult,
  EcpayCardDetails,
} from "./backauth/provider.js";
export {
  ECPAY_BACKAUTH_ORIGINS,
  ECPAY_BACKAUTH_PATHS,
  ECPAY_SANDBOX_NO_3D,
  ECPAY_TEST_CARD,
  resolveBackAuthOrigin,
} from "./backauth/config.js";
export type { EcpayBackAuthProviderConfig } from "./backauth/config.js";
export { ECPAY_BACKAUTH_NOTIFY_ACK, verifyEcpayBackAuthNotify } from "./backauth/notify.js";
export type {
  EcpayBackAuthNotify,
  EcpayBackAuthNotifyCredentials,
  EcpayBackAuthNotifyEnvelope,
} from "./backauth/notify.js";
