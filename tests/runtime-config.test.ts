import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadRuntimeConfig } from "../src/runtime-config.js";

const LONG_TOKEN = "a".repeat(64);

function clearEnvironment(): void {
  for (const name of [
    "K_SERVICE",
    "MCP_TRANSPORT",
    "MCP_ACCESS_TOKEN",
    "MCP_ALLOW_UNAUTHENTICATED",
    "PUBLIC_BASE_URL",
    "MCP_ALLOWED_ORIGINS",
    "MCP_ALLOWED_HOSTS",
    "YOUTUBE_CURSOR_SECRET",
    "YOUTUBE_CURSOR_TTL_SECONDS",
    "YOUTUBE_MAX_RESULT_BYTES",
    "YT_DLP_POT_PROVIDER_ENABLED",
    "YOUTUBE_QUOTA_STORE",
    "GOOGLE_CLOUD_PROJECT",
    "MCP_OAUTH_ENABLED",
    "MCP_OAUTH_ISSUER",
    "MCP_OAUTH_RESOURCE",
    "MCP_OAUTH_SCOPE",
    "MCP_OAUTH_LOGIN_SECRET",
    "MCP_OAUTH_SIGNING_SECRET",
    "MCP_OAUTH_STORE",
    "MCP_OAUTH_CODE_COLLECTION",
  ]) {
    vi.stubEnv(name, "");
  }
}

afterEach(() => vi.unstubAllEnvs());

describe("runtime config", () => {
  it("keeps stdio local and uses bounded context defaults", () => {
    clearEnvironment();
    expect(loadRuntimeConfig(["--stdio"]).transport).toBe("stdio");
    const config = loadConfig();
    expect(config.cursorTtlMs).toBe(86_400_000);
    expect(config.maxResultBytes).toBe(12_288);
    expect(config.cursorSecretSource).toBe("ephemeral");
    expect(config.ytDlpPotProviderEnabled).toBe(false);
  });

  it("enables the optional yt-dlp PO-token integration explicitly", () => {
    clearEnvironment();
    vi.stubEnv("YT_DLP_POT_PROVIDER_ENABLED", "true");
    expect(loadConfig().ytDlpPotProviderEnabled).toBe(true);
    vi.stubEnv("YT_DLP_POT_PROVIDER_ENABLED", "sometimes");
    expect(() => loadConfig()).toThrow(/must be a boolean/u);
  });

  it("requires strong secrets and derives the hosted OAuth identifiers", () => {
    clearEnvironment();
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
    vi.stubEnv("PUBLIC_BASE_URL", "https://youtube.example.run.app");
    vi.stubEnv("MCP_OAUTH_LOGIN_SECRET", "l".repeat(32));
    vi.stubEnv("MCP_OAUTH_SIGNING_SECRET", "s".repeat(32));
    const runtime = loadRuntimeConfig(["--http"]);
    expect(runtime.http.oauth).toMatchObject({
      issuer: "https://youtube.example.run.app",
      resource: "https://youtube.example.run.app/mcp",
      scope: "youtube.read",
      store: "memory",
    });
  });

  it("refuses public HTTP and response caps above 32 KiB", () => {
    clearEnvironment();
    expect(() => loadRuntimeConfig(["--http"])).toThrow(/MCP_ACCESS_TOKEN/u);
    vi.stubEnv("YOUTUBE_MAX_RESULT_BYTES", "32769");
    expect(() => loadConfig()).toThrow(/must not exceed 32768/u);
  });

  it("derives persistent cursor signing and Cloud guards from MCP settings", () => {
    clearEnvironment();
    vi.stubEnv("MCP_ACCESS_TOKEN", LONG_TOKEN);
    vi.stubEnv("PUBLIC_BASE_URL", "https://youtube-aio.example.run.app/");
    vi.stubEnv("YOUTUBE_QUOTA_STORE", "firestore");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "test-project");
    const runtime = loadRuntimeConfig(["--http"]);
    expect(runtime.http.publicBaseUrl).toBe("https://youtube-aio.example.run.app");
    expect(runtime.http.allowedOrigins).toContain(
      "https://youtube-aio.example.run.app",
    );
    expect(runtime.http.allowedHosts).toContain("youtube-aio.example.run.app");
    const app = loadConfig();
    expect(app.cursorSecretSource).toBe("mcp-access-token");
    expect(app.quotaStoreMode).toBe("firestore");
    expect(app.firestoreProjectId).toBe("test-project");
  });
});
