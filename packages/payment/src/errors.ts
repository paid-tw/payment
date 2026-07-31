/**
 * One normalized error type for every provider, mirroring @paid-tw/einvoice's
 * InvoiceError: adapters map provider/gateway error codes onto a stable
 * {@link PaymentErrorCode} while preserving the provider's raw code/message/body.
 */

export type PaymentErrorCode =
  | "AUTH" // bad/missing credentials, signature/hash mismatch
  | "VALIDATION" // request rejected before or by the gateway as malformed
  | "NOT_FOUND" // order/transaction does not exist
  | "CONFLICT" // duplicate order, already refunded, illegal state transition
  | "NETWORK" // transport failure (DNS/TLS/timeout/connection reset)
  | "PROVIDER" // gateway returned an error we don't map more specifically
  | "UNSUPPORTED" // provider lacks the requested capability
  | "UNKNOWN";

/**
 * Global brand so {@link isPaymentError} narrows correctly even across two
 * copies of this module (dual ESM/CJS, version skew) — same trick InvoiceError
 * uses. `instanceof` would fail in that case; the Symbol.for check does not.
 */
const BRAND = Symbol.for("@paid-tw/payment.PaymentError");

export interface PaymentErrorOptions {
  /** The provider's own error code (e.g. PAYUNi `QUERY03001`). */
  rawCode?: string;
  /** The provider's own error message, verbatim. */
  rawMessage?: string;
  /** The raw provider payload, for debugging. */
  raw?: unknown;
  cause?: unknown;
}

export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  readonly provider?: string;
  readonly rawCode?: string;
  readonly rawMessage?: string;
  readonly raw?: unknown;

  constructor(
    code: PaymentErrorCode,
    message: string,
    provider?: string,
    options: PaymentErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PaymentError";
    this.code = code;
    this.provider = provider;
    this.rawCode = options.rawCode;
    this.rawMessage = options.rawMessage;
    this.raw = options.raw;
    Object.defineProperty(this, BRAND, { value: true, enumerable: false });
  }

  /**
   * Structured-logging shape. By default `JSON.stringify(error)` only keeps an
   * Error's enumerable own properties; this keeps the normalized fields. `raw`
   * is intentionally omitted (it can be large or sensitive).
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      provider: this.provider,
      code: this.code,
      message: this.message,
      rawCode: this.rawCode,
      rawMessage: this.rawMessage,
    };
  }
}

/** Type guard that survives duplicate module copies (checks the global brand). */
export function isPaymentError(value: unknown): value is PaymentError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[BRAND] === true
  );
}
