/**
 * `@paid-tw/payment-ecpay/backauth` — 信用卡幕後授權 (BackAuth).
 *
 * ⚠️ **This entry point accepts a raw card number.** It is a separate subpath, not
 * part of the package root, precisely so that an application can demonstrate by its
 * import graph that it never pulls in a raw-PAN surface.
 *
 * PCI-DSS scope follows from *handling* card data, so an app that does not call
 * {@link createEcpayBackAuthProvider} stays in SAQ A regardless. Keeping this on its
 * own subpath adds the part that scope alone cannot give you: an auditable, mechanical
 * answer to "does this build contain the card-accepting adapter?" — greppable in a
 * lockfile-to-bundle trail rather than argued from intent.
 *
 * The other three ECPay adapters (AIO, 站內付 2.0, 非信用卡幕後取號) never see card data
 * and live at the package root.
 *
 * @see https://developers.ecpay.com.tw/45876
 */
export { createEcpayBackAuthProvider } from "./provider.js";
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
  EcpayBackAuthRefundInput,
  EcpayBackAuthResult,
  EcpayCardDetails,
  EcpayPeriodAction,
  EcpayPeriodActionInput,
  EcpayPeriodActionResult,
  EcpayPeriodExecution,
  EcpayPeriodOrder,
  EcpayPeriodProgress,
  EcpayPeriodSchedule,
} from "./provider.js";
export {
  ECPAY_BACKAUTH_ORIGINS,
  ECPAY_BACKAUTH_PATHS,
  ECPAY_SANDBOX_NO_3D,
  ECPAY_TEST_CARD,
  resolveBackAuthOrigin,
} from "./config.js";
export type { EcpayBackAuthProviderConfig } from "./config.js";
export {
  ECPAY_BACKAUTH_NOTIFY_ACK,
  verifyEcpayBackAuthNotify,
  verifyEcpayPeriodNotify,
} from "./notify.js";
export type {
  EcpayBackAuthNotify,
  EcpayBackAuthNotifyCredentials,
  EcpayBackAuthNotifyEnvelope,
  EcpayPeriodNotify,
} from "./notify.js";
