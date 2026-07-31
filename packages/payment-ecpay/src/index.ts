// @paid-tw/payment-ecpay — ECPay 綠界 All-in-One payment adapter.
export {
  createEcpayProvider,
  computeCheckMacValue,
} from "./provider.js";
export type {
  EcpayProvider,
  EcpayCheckoutForm,
  EcpayRefundResult,
} from "./provider.js";
export {
  ECPAY_ORIGINS,
  ECPAY_SANDBOX,
  ECPAY_SANDBOX_PORTAL,
  resolveEcpayOrigin,
} from "./config.js";
export {
  ECPAY_NOTIFY_ACK,
  coerceNotifyBody,
  verifyPaymentNotify,
} from "./notify.js";
export type {
  EcpayNotifyBody,
  EcpayNotifyCredentials,
  EcpayNotifyInput,
  EcpayPaymentNotify,
} from "./notify.js";
