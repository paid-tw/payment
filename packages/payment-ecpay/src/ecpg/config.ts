import type { ProviderRuntimeConfig } from "@paid-tw/payment";

/** 站內付 2.0 (ECPG) hosts. */
export const ECPG_ORIGINS = {
  sandbox: "https://ecpg-stage.ecpay.com.tw",
  production: "https://ecpg.ecpay.com.tw",
} as const;

export interface EcpgProviderConfig extends ProviderRuntimeConfig {
  /** Optional PlatformID for partner platforms. */
  platformId?: string;
}

export function resolveEcpgOrigin(config: { baseUrl?: string; sandbox?: boolean }): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return (config.sandbox ? ECPG_ORIGINS.sandbox : ECPG_ORIGINS.production).replace(/\/+$/, "");
}
