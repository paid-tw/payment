import { describe, expect, it } from "vitest";
import * as backauthEntry from "../backauth/index.js";
import * as rootEntry from "../index.js";

/**
 * Guards the packaging decision behind `@paid-tw/payment-ecpay/backauth`.
 *
 * 信用卡幕後授權 is the only adapter that accepts a raw card number, and it sits on its
 * own subpath so an application can show by import graph that it never pulls in a
 * raw-PAN surface. PCI-DSS scope follows from *handling* card data — not calling the
 * factory keeps you in SAQ A either way — but the split is what makes that
 * mechanically checkable instead of a claim.
 *
 * Re-exporting BackAuth from the root would silently undo that, and nothing else in
 * the test suite would notice, so it is asserted here.
 */
const RAW_PAN_PATTERN = /BackAuth|BACKAUTH|TEST_CARD|NO_3D/i;

describe("package entry points", () => {
  it("keeps every raw-PAN symbol out of the root entry", () => {
    const leaked = Object.keys(rootEntry).filter((name) => RAW_PAN_PATTERN.test(name));
    expect(leaked).toEqual([]);
  });

  it("still exports the three card-data-free adapters from the root", () => {
    expect(rootEntry).toHaveProperty("createEcpayProvider");
    expect(rootEntry).toHaveProperty("createEcpayEcpgProvider");
    expect(rootEntry).toHaveProperty("createEcpayPayCodeProvider");
  });

  it("exports the credit queries at the root, since neither takes card data", () => {
    // 單筆明細 takes order ids; 發卡行 takes a 6-9 digit BIN prefix. Putting them behind
    // the raw-PAN subpath would force a card-free app to import that surface.
    expect(rootEntry).toHaveProperty("queryEcpayCreditDetail");
    expect(rootEntry).toHaveProperty("queryEcpayCardInfo");
    expect(rootEntry).toHaveProperty("ECPAY_SANDBOX_GATEWAY");
  });

  it("exposes the BackAuth surface on the subpath instead", () => {
    expect(backauthEntry).toHaveProperty("createEcpayBackAuthProvider");
    expect(backauthEntry).toHaveProperty("verifyEcpayBackAuthNotify");
    expect(backauthEntry).toHaveProperty("ECPAY_BACKAUTH_NOTIFY_ACK");
    // The stage helpers a BackAuth integrator needs live here too, not at the root.
    expect(backauthEntry).toHaveProperty("ECPAY_SANDBOX_NO_3D");
    expect(backauthEntry).toHaveProperty("ECPAY_TEST_CARD");
  });

  it("exports the whole 定期定額 surface from the subpath", () => {
    // The gap this closes: a caller following the README would have had to reach into
    // `dist/backauth/notify.js` for the cycle-notify verifier, because the docs
    // advertised it while the entry point did not export it.
    expect(backauthEntry).toHaveProperty("verifyEcpayPeriodNotify");
  });

  it("does not duplicate the shared adapters onto the subpath", () => {
    // The subpath is the raw-PAN adapter only; it must not become a second front door
    // to the whole package.
    for (const name of [
      "createEcpayProvider",
      "createEcpayEcpgProvider",
      "createEcpayPayCodeProvider",
    ]) {
      expect(backauthEntry).not.toHaveProperty(name);
    }
  });
});
