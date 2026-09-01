export type TransportMode = "stdio" | "http";

export interface HttpRuntimeConfig {
  host: string;
  port: number;
  publicBaseUrl: string | undefined;
  mcpPath: string;
  healthPath: string;
  accessToken: string | undefined;
  allowUnauthenticated: boolean;
  allowedOrigins: string[];
  allowedHosts: string[];
  maxBodyBytes: number;
  requestTimeoutMs: number;
}

export interface GoogleOAuthRuntimeConfig {
  enabled: boolean;
  clientId: string | undefined;
  clientSecret: string | undefined;
  stateSecret: string | undefined;
  setupToken: string | undefined;
  refreshTokenConfigured: boolean;
  redirectPath: string;
  setupPath: string;
  startPath: string;
  statusPath: string;
  scopes: string[];
  stateTtlSeconds: number;
}

export interface RuntimeConfig {
  transport: TransportMode;
  http: HttpRuntimeConfig;
  googleOAuth: GoogleOAuthRuntimeConfig;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

function readInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function normalizePath(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback;
  if (!raw.startsWith("/")) {
    throw new Error(`${name} must start with '/'.`);
  }
  if (raw.includes("?") || raw.includes("#")) {
    throw new Error(`${name} must not include a query string or fragment.`);
  }
  return raw.length > 1 ? raw.replace(/\/+$/u, "") : raw;
}

function readTransport(argv: string[]): TransportMode {
  const hasHttp = argv.includes("--http");
  const hasStdio = argv.includes("--stdio");
  if (hasHttp && hasStdio) {
    throw new Error("Choose only one of --http or --stdio.");
  }
  if (hasHttp) return "http";
  if (hasStdio) return "stdio";

  const raw = process.env.MCP_TRANSPORT?.trim().toLowerCase();
  if (raw) {
    if (raw === "http" || raw === "stdio") return raw;
    throw new Error("MCP_TRANSPORT must be http or stdio.");
  }

  return process.env.K_SERVICE ? "http" : "stdio";
}

function readPublicBaseUrl(): string | undefined {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (!raw) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute URL.");
  }

  const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname,
  );
  if (parsed.protocol !== "https:" && !(isLocalhost && parsed.protocol === "http:")) {
    throw new Error(
      "PUBLIC_BASE_URL must use HTTPS, except for localhost development.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "PUBLIC_BASE_URL must not include credentials, a query string, or a fragment.",
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function readOrigins(publicBaseUrl: string | undefined): string[] {
  const origins = new Set<string>();
  if (publicBaseUrl) origins.add(new URL(publicBaseUrl).origin);

  for (const raw of splitList(process.env.MCP_ALLOWED_ORIGINS)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid MCP_ALLOWED_ORIGINS entry: ${raw}`);
    }
    if (parsed.origin === "null") {
      throw new Error(`MCP_ALLOWED_ORIGINS must contain HTTP(S) origins: ${raw}`);
    }
    origins.add(parsed.origin);
  }
  return [...origins];
}

function readHosts(publicBaseUrl: string | undefined): string[] {
  const hosts = new Set<string>();
  if (publicBaseUrl) hosts.add(new URL(publicBaseUrl).hostname.toLowerCase());

  for (const raw of splitList(process.env.MCP_ALLOWED_HOSTS)) {
    const normalized = raw
      .replace(/^https?:\/\//iu, "")
      .split("/")[0]
      ?.split(":")[0]
      ?.trim()
      .toLowerCase();
    if (!normalized) {
      throw new Error(`Invalid MCP_ALLOWED_HOSTS entry: ${raw}`);
    }
    hosts.add(normalized);
  }
  return [...hosts];
}

function readScopes(): string[] {
  const configured = splitList(process.env.GOOGLE_OAUTH_SCOPES);
  return configured.length > 0
    ? [...new Set(configured)]
    : ["https://www.googleapis.com/auth/youtube.readonly"];
}

function requireMinimumSecret(
  value: string | undefined,
  name: string,
  minimumLength = 32,
): string {
  if (!value) throw new Error(`${name} is required.`);
  if (value.length < minimumLength) {
    throw new Error(`${name} must be at least ${minimumLength} characters.`);
  }
  return value;
}

export function loadRuntimeConfig(
  argv: string[] = process.argv.slice(2),
): RuntimeConfig {
  const transport = readTransport(argv);
  const publicBaseUrl = readPublicBaseUrl();
  const accessToken = process.env.MCP_ACCESS_TOKEN?.trim() || undefined;
  const allowUnauthenticated = readBoolean(
    "MCP_ALLOW_UNAUTHENTICATED",
    false,
  );

  if (accessToken && accessToken.length < 32) {
    throw new Error("MCP_ACCESS_TOKEN must be at least 32 characters.");
  }
  if (transport === "http" && !accessToken && !allowUnauthenticated) {
    throw new Error(
      "HTTP mode requires MCP_ACCESS_TOKEN. Set MCP_ALLOW_UNAUTHENTICATED=true only for an intentionally public server.",
    );
  }

  const googleOAuthEnabled = readBoolean("GOOGLE_OAUTH_ENABLED", false);
  const googleOAuth: GoogleOAuthRuntimeConfig = {
    enabled: googleOAuthEnabled,
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || undefined,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || undefined,
    stateSecret: process.env.GOOGLE_OAUTH_STATE_SECRET?.trim() || undefined,
    setupToken: process.env.GOOGLE_OAUTH_SETUP_TOKEN?.trim() || undefined,
    refreshTokenConfigured: Boolean(
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim(),
    ),
    redirectPath: normalizePath(
      "GOOGLE_OAUTH_REDIRECT_PATH",
      "/oauth/google/callback",
    ),
    setupPath: normalizePath("GOOGLE_OAUTH_SETUP_PATH", "/oauth/google/setup"),
    startPath: normalizePath("GOOGLE_OAUTH_START_PATH", "/oauth/google/start"),
    statusPath: normalizePath("GOOGLE_OAUTH_STATUS_PATH", "/oauth/google/status"),
    scopes: readScopes(),
    stateTtlSeconds: readInteger(
      "GOOGLE_OAUTH_STATE_TTL_SECONDS",
      600,
      60,
      3_600,
    ),
  };

  if (googleOAuth.enabled) {
    if (!publicBaseUrl) {
      throw new Error("PUBLIC_BASE_URL is required when GOOGLE_OAUTH_ENABLED=true.");
    }
    if (!googleOAuth.clientId) {
      throw new Error("GOOGLE_OAUTH_CLIENT_ID is required when Google OAuth is enabled.");
    }
    if (!googleOAuth.clientSecret) {
      throw new Error(
        "GOOGLE_OAUTH_CLIENT_SECRET is required when Google OAuth is enabled.",
      );
    }
    requireMinimumSecret(
      googleOAuth.stateSecret,
      "GOOGLE_OAUTH_STATE_SECRET",
    );
    requireMinimumSecret(
      googleOAuth.setupToken,
      "GOOGLE_OAUTH_SETUP_TOKEN",
    );
  }

  return {
    transport,
    http: {
      host: process.env.HOST?.trim() || "0.0.0.0",
      port: readInteger("PORT", 8080, 1, 65_535),
      publicBaseUrl,
      mcpPath: normalizePath("MCP_PATH", "/mcp"),
      healthPath: normalizePath("HEALTH_PATH", "/healthz"),
      accessToken,
      allowUnauthenticated,
      allowedOrigins: readOrigins(publicBaseUrl),
      allowedHosts: readHosts(publicBaseUrl),
      maxBodyBytes: readInteger(
        "HTTP_MAX_BODY_BYTES",
        2 * 1024 * 1024,
        1_024,
        32 * 1024 * 1024,
      ),
      requestTimeoutMs: readInteger(
        "HTTP_REQUEST_TIMEOUT_MS",
        300_000,
        1_000,
        3_600_000,
      ),
    },
    googleOAuth,
  };
}

export function googleOAuthRedirectUri(config: RuntimeConfig): string | undefined {
  if (!config.http.publicBaseUrl) return undefined;
  return `${config.http.publicBaseUrl}${config.googleOAuth.redirectPath}`;
}
