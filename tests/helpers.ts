import type { RuntimeConfig } from "../src/runtime-config.js";
import type { AppConfig } from "../src/types.js";

export const TEST_ACCESS_TOKEN = "test-access-token-".repeat(4);

export function testAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: undefined,
    providerMode: "official",
    transcriptProviders: [],
    ytDlpPath: "yt-dlp",
    ytDlpPotProviderEnabled: false,
    defaultRegion: "US",
    defaultLanguage: "en",
    requestTimeoutMs: 5_000,
    cacheTtlMs: 60_000,
    apiDailyBudget: 100,
    searchDailyBudget: 10,
    cursorSecret: "cursor-test-secret-".repeat(3),
    cursorSecretSource: "explicit",
    cursorTtlMs: 86_400_000,
    maxResultBytes: 12_288,
    quotaStoreMode: "memory",
    firestoreProjectId: undefined,
    ...overrides,
  };
}

export function testRuntimeConfig(
  overrides: Partial<RuntimeConfig["http"]> = {},
): RuntimeConfig {
  return {
    transport: "http",
    http: {
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: undefined,
      mcpPath: "/mcp",
      healthPath: "/healthz",
      accessToken: TEST_ACCESS_TOKEN,
      allowUnauthenticated: false,
      allowedOrigins: [],
      allowedHosts: [],
      maxBodyBytes: 2 * 1_024 * 1_024,
      requestTimeoutMs: 300_000,
      ...overrides,
    },
  };
}
