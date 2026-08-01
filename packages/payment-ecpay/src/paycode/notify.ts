import {
  type EcpgNotifyEnvelope,
  type EcpgPaymentNotify,
  verifyEcpgPaymentNotify,
} from "../ecpg/notify.js";

/**
 * Merchant response body for the 幕後取號 ReturnURL. Despite the notify arriving as
 * AES-JSON, ECPay still wants the plain AIO string back.
 *
 * Anything else (`"1|OK"` with quotes, `1|ok`, `1OK`, blank) counts as a failure:
 * ECPay then re-sends every 5–15 minutes, four times a day.
 *
 * @see https://developers.ecpay.com.tw/28010
 */
export const ECPAY_PAYCODE_NOTIFY_ACK = "1|OK" as const;

export interface EcpayPayCodeNotifyCredentials {
  hashKey: string;
  hashIv: string;
  /** When set, rejects notifies whose outer or inner MerchantID does not match. */
  merchantId?: string;
}

/** Verified 幕後取號 payment notify. Same shape as the 站內付 2.0 notify. */
export type EcpayPayCodeNotify = EcpgPaymentNotify;
export type EcpayPayCodeNotifyEnvelope = EcpgNotifyEnvelope;

/**
 * Verify a 非信用卡幕後取號 ReturnURL notify (TransCode + AES-decrypt Data), then
 * respond with {@link ECPAY_PAYCODE_NOTIFY_ACK}.
 *
 * Ship only when `success && !simulated`:
 *   - `success` is `RtnCode === 1`; ECPay is explicit that a non-1 RtnCode must not
 *     trigger fulfilment.
 *   - `simulated` marks a 廠商後台「模擬付款」 test — no money moved and ECPay will
 *     not settle, so shipping on it is a real loss.
 *
 * BARCODE notifies lag real payment by roughly two days (超商 batch timing), so a
 * pending barcode order is not evidence of an unpaid consumer.
 *
 * @see https://developers.ecpay.com.tw/28010
 */
export function verifyEcpayPayCodeNotify(
  input: EcpayPayCodeNotifyEnvelope | string | Record<string, unknown>,
  credentials: EcpayPayCodeNotifyCredentials,
): EcpayPayCodeNotify {
  return verifyEcpgPaymentNotify(input, { ...credentials, providerName: "ecpay-paycode" });
}
