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
 * Persist `tradeNo` (綠界交易編號): that — **not** `gwsr` — is what
 * {@link import("./provider.js").EcpayBackAuthProvider.creditDoAction} needs for
 * 關帳/退刷. `creditRefundId` carries `CardInfo.Gwsr`, the bank authorization
 * reference, which 信用卡單筆明細查詢 uses (not implemented in this adapter) and which
 * is useful for reconciliation — but DoAction does not accept it.
 *
 * @see https://developers.ecpay.com.tw/45907
 */
export function verifyEcpayBackAuthNotify(
  input: EcpayBackAuthNotifyEnvelope | string | Record<string, unknown>,
  credentials: EcpayBackAuthNotifyCredentials,
): EcpayBackAuthNotify {
  return verifyEcpgPaymentNotify(input, { ...credentials, providerName: "ecpay-backauth" });
}

/**
 * A 定期定額 cycle result, as posted to `PeriodReturnURL`.
 *
 * Same AES-JSON envelope and `1|OK` ack as the one-off notify, but it arrives **once per
 * cycle** for the life of the schedule, so the interesting part is the progress counters
 * rather than the single result: `totalSuccessTimes` against the original `execTimes`
 * tells you where in the schedule you are.
 *
 * @see https://developers.ecpay.com.tw/15162
 */
export interface EcpayPeriodNotify extends EcpgPaymentNotify {
  period?: {
    type?: string;
    frequency?: number;
    execTimes?: number;
    periodAmount?: number;
    totalSuccessTimes?: number;
    totalSuccessAmount?: number;
  };
}

/**
 * Verify a 定期定額 cycle notify, then respond with
 * {@link ECPAY_BACKAUTH_NOTIFY_ACK}.
 *
 * Treat each notify as one cycle, not as the order: `success` is that cycle's
 * authorization. A failed cycle does not end the schedule — ECPay keeps going, and
 * `creditCardPeriodAction("ReAuth")` can retry **only the latest** failure.
 *
 * Idempotency needs the cycle, not just the order: every notify for a schedule carries
 * the same `merTradeNo`, so key on `merTradeNo` + `period.totalSuccessTimes` (or the
 * cycle's own `tradeNo`) or you will treat cycle 5 as a replay of cycle 4.
 *
 * @see https://developers.ecpay.com.tw/15162
 */
export function verifyEcpayPeriodNotify(
  input: EcpayBackAuthNotifyEnvelope | string | Record<string, unknown>,
  credentials: EcpayBackAuthNotifyCredentials,
): EcpayPeriodNotify {
  const base = verifyEcpgPaymentNotify(input, {
    ...credentials,
    providerName: "ecpay-backauth",
  });
  const cardInfo = (base.data.CardInfo ?? {}) as Record<string, unknown>;
  const type = asText(cardInfo.PeriodType);

  return {
    ...base,
    // PeriodType is the marker that this really is a 定期定額 notify; without it the
    // counters would be an object of undefined values.
    period: type
      ? {
          type,
          frequency: num(cardInfo.Frequency),
          execTimes: num(cardInfo.ExecTimes),
          periodAmount: num(cardInfo.PeriodAmount),
          totalSuccessTimes: num(cardInfo.TotalSuccessTimes),
          totalSuccessAmount: num(cardInfo.TotalSuccessAmount),
        }
      : undefined,
  };
}

function asText(input: unknown): string | undefined {
  return typeof input === "string" && input ? input : undefined;
}

function num(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const value = Number(input);
  return Number.isNaN(value) ? undefined : value;
}
