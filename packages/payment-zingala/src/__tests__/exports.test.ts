import { describe, expect, it } from "vitest";
import * as entry from "../index.js";

/**
 * Guards the package's public surface.
 *
 * This exists because the surface was silently empty: `createZingalaClient` — the whole
 * point of the package — was missing from `src/index.ts`, and nothing noticed. Every other
 * test imports `../provider.js` directly, so they all passed while a consumer following
 * the README could not import anything at all.
 *
 * `package.json#exports` exposes only ".", so anything absent here is unreachable rather
 * than merely inconvenient.
 */
const REQUIRED_VALUES = [
  // The client and its two inbound helpers — what the README's examples use.
  "createZingalaClient",
  "verifyZingalaNotify",
  "verifyZingalaConfirmRequest",
  "buildZingalaConfirmResponse",
  "ZINGALA_NOTIFY_ACK",
  // Crypto, for anyone verifying a notify without the client.
  "computeDigest",
  "verifyDigest",
  "decryptCustomerInfo",
  "encryptCustomerInfo",
  "phpUrlEncode",
  // Codes and states.
  "describeResult",
  "describeTransactionState",
  "mapTransactionState",
  "ZINGALA_RESULT_CODES",
  "ZINGALA_RETRYABLE",
  "ZINGALA_SUCCESS",
  "ZINGALA_TERMINAL_STATES",
  "ZINGALA_TRANSACTION_STATES",
  // Fee arithmetic — usable standalone to show a schedule before applying.
  "calculateInstalmentPlan",
  "availablePeriods",
  "findFeeOption",
  // Config and low-level transport.
  "ZINGALA_ORIGINS",
  "ZINGALA_PATHS",
  "resolveZingalaOrigin",
  "isZingalaSandbox",
  "zingalaPost",
  "zingalaPostForBytes",
] as const;

describe("package entry point", () => {
  it.each(REQUIRED_VALUES)("exports %s", (name) => {
    expect(entry).toHaveProperty(name);
    expect(entry[name as keyof typeof entry]).toBeDefined();
  });

  it("exports every symbol the README's examples import", () => {
    // The specific set that was missing. Named separately so a failure says "the README
    // is a lie" rather than just "an export is gone".
    for (const name of [
      "createZingalaClient",
      "verifyZingalaNotify",
      "verifyZingalaConfirmRequest",
      "buildZingalaConfirmResponse",
      "availablePeriods",
    ]) {
      expect(entry, `README imports ${name} from the package root`).toHaveProperty(name);
    }
  });

  it("keeps createZingalaClient callable from the entry point", () => {
    // `toHaveProperty` would pass for a re-exported type. Build a real client.
    const client = entry.createZingalaClient({
      merchantId: "99999999",
      apiKey: "k".repeat(32),
      aesKey: "A".repeat(32),
      aesIv: "0".repeat(16),
      sandbox: true,
    });
    expect(client.name).toBe("zingala");
    for (const method of [
      "applyInstallment",
      "getOrder",
      "getOrders",
      "capture",
      "refund",
      "checkMember",
      "getFeeSchedule",
      "getBankBranches",
      "downloadApprovalNotice",
    ]) {
      expect(typeof client[method as keyof typeof client]).toBe("function");
    }
  });

  it("does not leak internal helpers", () => {
    // These are implementation details of the normalizers; exporting them would freeze
    // shapes we may want to change.
    for (const name of ["asRecord", "text", "num", "assertAmount", "assertApplyInput"]) {
      expect(entry).not.toHaveProperty(name);
    }
  });
});
