import {
  type EcpgNotifyEnvelope,
  type EcpgPaymentNotify,
  verifyEcpgPaymentNotify,
} from "../ecpg/notify.js";

/**
 * Merchant response body for the 幕後授權 ReturnURL — the same bare string every other
 * ECPay notify wants, despite the notify itself being AES-JSON.
 *
 * @see https://developers.ecpay.com.tw/45907
 */
export const ECPAY_BACKAUTH_NOTIFY_ACK = "1|OK" as const;

export interface EcpayBackAuthNotifyCredentials {
  hashKey: string;
  hashIv: string;
  /** When set, rejects notifies whose outer or inner MerchantID does not match. */
  merchantId?: string;
}

export type EcpayBackAuthNotify = EcpgPaymentNotify;
export type EcpayBackAuthNotifyEnvelope = EcpgNotifyEnvelope;

/**
 * Verify a 信用卡幕後授權 ReturnURL notify, then respond with
 * {@link ECPAY_BACKAUTH_NOTIFY_ACK}.
 *
 * This is the notify that closes the 3DS branch: when `createPayment` returned
 * `{ mode: "3ds" }`, the authorization result only reaches you here (and, for the
 * browser, at `OrderResultURL`). Ship on `success && !simulated`.
 *
 * `creditRefundId` carries `CardInfo.Gwsr`, which is the handle
 * `creditDoAction` needs for 關帳/退刷 — persist it.
 *
 * @see https://developers.ecpay.com.tw/45907
 */
export function verifyEcpayBackAuthNotify(
  input: EcpayBackAuthNotifyEnvelope | string | Record<string, unknown>,
  credentials: EcpayBackAuthNotifyCredentials,
): EcpayBackAuthNotify {
  return verifyEcpgPaymentNotify(input, { ...credentials, providerName: "ecpay-backauth" });
}
