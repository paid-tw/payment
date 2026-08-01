/**
 * Scalar coercion for ECPay payloads.
 *
 * ECPay is inconsistent about "no value": the same logical field arrives as an
 * empty string on one endpoint and JSON `null` on another (verified — the 幕後取號
 * notify sends `ATMInfo.ATMAccBank: ""` while `QueryTrade` sends `null`), and
 * optional objects can mix a real value with a null sibling.
 *
 * A bare `String(value)` turns those into the literal `"null"`, which then looks
 * like a real bank code or store id to any caller doing a truthiness or equality
 * check. Every normalizer goes through {@link text} instead, so absent, `null` and
 * `""` all collapse to `undefined`.
 */

/** Coerce a JSON scalar to a string; objects, arrays, `null` and `undefined` → `""`. */
export function str(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
    return String(input);
  }
  return "";
}

/**
 * Optional-field form of {@link str}: `undefined` unless there is real content.
 * Use for every string field on a normalized result.
 */
export function text(input: unknown): string | undefined {
  return str(input) || undefined;
}

/** Coerce to a finite number, treating absent / `null` / `""` / non-numeric as missing. */
export function asNumber(input: unknown): number | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const num = Number(input);
  return Number.isNaN(num) ? undefined : num;
}
