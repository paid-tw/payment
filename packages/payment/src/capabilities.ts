/**
 * Capabilities are declared by each provider, not discovered at call time —
 * same contract as @paid-tw/einvoice. Callers feature-detect with
 * {@link supports}; adapters guard entry points with {@link assertSupports},
 * which throws a normalized UNSUPPORTED {@link PaymentError}.
 */
import { PaymentError } from "./errors.js";
import type { PaymentProvider } from "./provider.js";

export const Capability = {
  CREATE_PAYMENT: "CREATE_PAYMENT",
  GET_PAYMENT: "GET_PAYMENT",
  REFUND_PAYMENT: "REFUND_PAYMENT",
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

/** Whether a capability set (or provider) declares support for `capability`. */
export function supports(
  target: ReadonlySet<Capability> | PaymentProvider,
  capability: Capability,
): boolean {
  const set = "capabilities" in target ? target.capabilities : target;
  return set.has(capability);
}

/**
 * Guard an adapter entry point. Accepts either:
 * - `(providerName, capabilities, capability)` — used inside adapters
 * - `(provider, capability)` — used by application code (einvoice style)
 */
export function assertSupports(
  providerOrName: string | PaymentProvider,
  capabilitiesOrCap: ReadonlySet<Capability> | Capability,
  capability?: Capability,
): void {
  if (typeof providerOrName === "string") {
    const name = providerOrName;
    const capabilities = capabilitiesOrCap as ReadonlySet<Capability>;
    const cap = capability as Capability;
    if (!capabilities.has(cap)) {
      throw new PaymentError("UNSUPPORTED", `${name} 尚未支援 ${cap}`, name);
    }
    return;
  }

  const provider = providerOrName;
  const cap = capabilitiesOrCap as Capability;
  if (!provider.capabilities.has(cap)) {
    throw new PaymentError(
      "UNSUPPORTED",
      `${provider.name} 尚未支援 ${cap}`,
      provider.name,
    );
  }
}
