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
