import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  describeResult,
  describeTransactionState,
  mapTransactionState,
  ZINGALA_RESULT_CODES,
  ZINGALA_RETRYABLE,
  ZINGALA_SUCCESS,
  ZINGALA_TERMINAL_STATES,
  ZINGALA_TRANSACTION_STATES,
} from "../codes.js";

interface Exchange {
  label: string;
  body: string;
}
const exchanges = JSON.parse(
  readFileSync(new URL("./cassettes/uat-2026-08-02.json", import.meta.url), "utf8"),
) as Exchange[];

describe("result codes", () => {
  it("covers every result code the recorded cassette contains", () => {
    // The point of the cassette: any code the real API returned must be mapped, or a
    // caller gets a bare PROVIDER error for something we have literally seen.
    const seen = new Set<string>();
    for (const e of exchanges) {
      const parsed = JSON.parse(e.body) as { result?: string };
      if (parsed.result) seen.add(parsed.result);
    }
    expect(seen.size).toBeGreaterThan(4);
    for (const code of seen) {
      expect(ZINGALA_RESULT_CODES, `result ${code} was recorded but is unmapped`).toHaveProperty(
        code,
      );
    }
  });

  it("maps 801, which no manual version documents", () => {
    // Recorded: capture with a correct amount on an unconfirmed order. Manual 1.1.14's
    // table stops at 303/900/999 and has no 8xx range at all.
    const meta = ZINGALA_RESULT_CODES["801"];
    expect(meta?.code).toBe("CONFLICT");
    expect(meta?.source).toBe("recorded");
    expect(meta?.label).toContain("尚未確認");
  });

  it("keeps 中租's message when it says more than our label", () => {
    // `200 參數錯誤 : product_name 錯誤` — the field name after the colon is the only
    // clue about what was wrong, so it must survive normalization.
    const described = describeResult("200", "參數錯誤 : product_name 錯誤");
    expect(described.code).toBe("VALIDATION");
    expect(described.message).toContain("product_name");
  });

  it("does not duplicate the label when the message repeats it", () => {
    const described = describeResult("100", "訂單不存在");
    expect(described.message).toBe("訂單不存在");
  });

  it("falls back to PROVIDER for a code we have never seen", () => {
    const described = describeResult("777", "something new");
    expect(described.code).toBe("PROVIDER");
    expect(described.source).toBe("recorded");
    expect(described.message).toContain("something new");
  });

  it("treats 900 as non-retryable, because a bad enum lands there", () => {
    // Recorded: `fee_type: "bogus"` answers 900, not 200. Retrying that forever would be
    // the wrong reading of 系統發生錯誤.
    expect(ZINGALA_RETRYABLE.has("900")).toBe(false);
    expect(ZINGALA_RESULT_CODES["900"]?.label).toContain("無效的參數值");
  });

  it("marks only the codes 中租 tells you to retry", () => {
    expect([...ZINGALA_RETRYABLE].sort()).toEqual(["112", "199"]);
    for (const code of ZINGALA_RETRYABLE) {
      expect(ZINGALA_RESULT_CODES[code]?.label).toMatch(/請隔日或稍後再試/);
    }
  });

  it("normalizes a credit decline consistently with the other adapters", () => {
    // 300 額度不足 / 108 婉拒 → PROVIDER, matching ECPay's 10100252 / 10100248. Core has
    // no DECLINED code; see the note in codes.ts.
    expect(describeResult("300").code).toBe("PROVIDER");
    expect(describeResult("108").code).toBe("PROVIDER");
  });

  it("uses 000 for success and never surfaces it as a failure label", () => {
    expect(ZINGALA_SUCCESS).toBe("000");
  });
});

describe("transaction_state", () => {
  it.each([
    ["001", "pending-consumer"],
    ["002", "in-review"],
    ["003", "approved"],
    ["004", "capturing"],
    ["005", "disbursed"],
    ["006", "declined"],
    ["007", "cancelled"],
    ["008", "expired"],
    ["009", "partial-cancelling"],
  ])("maps %s to %s", (raw, state) => {
    expect(mapTransactionState(raw)).toBe(state);
  });

  it.each([undefined, null, "", "042"])("maps the unknown state %j to `unknown`", (raw) => {
    // Forward compatibility: 801 proved 中租 ships codes the manual omits, so an
    // unrecognised state must degrade rather than throw.
    expect(mapTransactionState(raw)).toBe("unknown");
  });

  it("names the unknown code in its description", () => {
    expect(describeTransactionState("042")).toContain("042");
    expect(describeTransactionState(undefined)).toBe("（無狀態碼）");
  });

  it("does not treat approval as the terminal success", () => {
    // The whole reason this is an underwriting state machine: 003 已核准 is not the end,
    // 005 已撥款 is, and that is days later.
    expect(ZINGALA_TERMINAL_STATES.has("approved")).toBe(false);
    expect(ZINGALA_TERMINAL_STATES.has("capturing")).toBe(false);
    expect(ZINGALA_TERMINAL_STATES.has("disbursed")).toBe(true);
  });

  it("marks every failure outcome terminal", () => {
    for (const state of ["declined", "cancelled", "expired"] as const) {
      expect(ZINGALA_TERMINAL_STATES.has(state)).toBe(true);
    }
  });

  it("matches the recorded state of a fresh order", () => {
    // The inquiry we recorded right after reserve_ec reported 001.
    const inquiry = exchanges.find((e) => e.label.includes("inquiry on the new order"));
    expect(inquiry).toBeDefined();
    const parsed = JSON.parse(inquiry?.body ?? "{}") as {
      info?: { transaction_state?: string }[];
    };
    expect(mapTransactionState(parsed.info?.[0]?.transaction_state)).toBe("pending-consumer");
  });

  it("keeps every documented state mapped to a distinct name", () => {
    const names = Object.values(ZINGALA_TRANSACTION_STATES).map((s) => s.state);
    expect(new Set(names).size).toBe(names.length);
  });
});
