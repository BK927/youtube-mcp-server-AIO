import { afterEach, describe, expect, it, vi } from "vitest";
import {
  googleOAuthRedirectUri,
  loadRuntimeConfig,
} from "../src/runtime-config.js";

const LONG_TOKEN = "a".repeat(64);

function clearRuntimeEnvironment(): void {
  const names = [
    "K_SERVICE",
    "MCP_TRANSPORT",
    "MCP_ACCESS_TOKEN",
    "MCP_ALLOW_UNAUTHENTICATED",
    "PUBLIC_BASE_URL",
    "MCP_ALLOWED_ORIGINS",
    "MCP_ALLOWED_HOSTS",
    "GOOGLE_OAUTH_ENABLED",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_STATE_SECRET",
    "GOOGLE_OAUTH_SETUP_TOKEN",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
  ];
  for (const name of names) vi.stubEnv(name, "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runtime config", () => {
  it("keeps stdio as the safe local default", () => {
    clearRuntimeEnvironment();
    const config = loadRuntimeConfig(["--stdio"]);
    expect(config.transport).toBe("stdio");
    expect(config.http.accessToken).toBeUndefined();
  });

  it("refuses an accidentally public HTTP server", () => {
    clearRuntimeEnvironment();
    expect(() => loadRuntimeConfig(["--http"])).toThrow(/MCP_ACCESS_TOKEN/u);
  });

  it("normalizes a Cloud Run base URL and derives host/origin guards", () => {
    clearRuntimeEnvironment();
    vi.stubEnv("MCP_ACCESS_TOKEN", LONG_TOKEN);
    vi.stubEnv("PUBLIC_BASE_URL", "https://youtube-aio.example.run.app/");

    const config = loadRuntimeConfig(["--http"]);
    expect(config.http.publicBaseUrl).toBe(
      "https://youtube-aio.example.run.app",
    );
    expect(config.http.allowedOrigins).toContain(
      "https://youtube-aio.example.run.app",
    );
    expect(config.http.allowedHosts).toContain(
      "youtube-aio.example.run.app",
    );
  });

  it("requires complete Google OAuth configuration when enabled", () => {
    clearRuntimeEnvironment();
    vi.stubEnv("MCP_ACCESS_TOKEN", LONG_TOKEN);
    vi.stubEnv("GOOGLE_OAUTH_ENABLED", "true");
    expect(() => loadRuntimeConfig(["--http"])).toThrow(/PUBLIC_BASE_URL/u);
  });

  it("produces the exact configured Google redirect URI", () => {
    clearRuntimeEnvironment();
    vi.stubEnv("MCP_ACCESS_TOKEN", LONG_TOKEN);
    vi.stubEnv("PUBLIC_BASE_URL", "https://youtube-aio.example.run.app");
    vi.stubEnv("GOOGLE_OAUTH_ENABLED", "true");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOOGLE_OAUTH_STATE_SECRET", "s".repeat(64));
    vi.stubEnv("GOOGLE_OAUTH_SETUP_TOKEN", "t".repeat(64));

    const config = loadRuntimeConfig(["--http"]);
    expect(googleOAuthRedirectUri(config)).toBe(
      "https://youtube-aio.example.run.app/oauth/google/callback",
    );
  });
});
