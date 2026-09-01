import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

interface OAuthStatePayload {
  version: 1;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

interface GoogleTokenEndpointResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  token_type?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface GoogleOAuthManagerConfig {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  redirectUri: string;
  scopes: string[];
  stateTtlSeconds: number;
  requestTimeoutMs?: number;
}

export interface GoogleOAuthGrant {
  refreshToken: string | undefined;
  accessTokenReceived: boolean;
  expiresInSeconds: number | undefined;
  grantedScopes: string[];
  tokenType: string | undefined;
  idTokenReceived: boolean;
}

export class GoogleOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function stateSignature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

export function createSignedOAuthState(
  secret: string,
  ttlSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string {
  const payload: OAuthStatePayload = {
    version: 1,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + ttlSeconds,
    nonce: randomBytes(24).toString("base64url"),
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = encodeBase64Url(stateSignature(encodedPayload, secret));
  return `${encodedPayload}.${signature}`;
}

export function verifySignedOAuthState(
  state: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): OAuthStatePayload {
  const [encodedPayload, encodedSignature, extra] = state.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    throw new GoogleOAuthError("invalid_state", "The OAuth state value is malformed.");
  }

  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new GoogleOAuthError("invalid_state", "The OAuth state signature is invalid.");
  }
  const expectedSignature = stateSignature(encodedPayload, secret);
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new GoogleOAuthError("invalid_state", "The OAuth state signature is invalid.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(encodedPayload));
  } catch {
    throw new GoogleOAuthError("invalid_state", "The OAuth state payload is invalid.");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("issuedAt" in parsed) ||
    typeof parsed.issuedAt !== "number" ||
    !("expiresAt" in parsed) ||
    typeof parsed.expiresAt !== "number" ||
    !("nonce" in parsed) ||
    typeof parsed.nonce !== "string"
  ) {
    throw new GoogleOAuthError("invalid_state", "The OAuth state payload is invalid.");
  }

  const payload = parsed as OAuthStatePayload;
  if (payload.issuedAt > nowSeconds + 60) {
    throw new GoogleOAuthError("invalid_state", "The OAuth state is not yet valid.");
  }
  if (payload.expiresAt < nowSeconds) {
    throw new GoogleOAuthError("expired_state", "The OAuth setup session has expired.");
  }
  return payload;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export class GoogleOAuthManager {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(
    readonly config: GoogleOAuthManagerConfig,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
  }

  createAuthorizationUrl(): string {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set(
      "state",
      createSignedOAuthState(this.config.stateSecret, this.config.stateTtlSeconds),
    );
    return url.toString();
  }

  async exchangeCallback(callbackUrl: URL): Promise<GoogleOAuthGrant> {
    const oauthError = callbackUrl.searchParams.get("error");
    if (oauthError) {
      const description = callbackUrl.searchParams.get("error_description");
      throw new GoogleOAuthError(
        oauthError,
        description || "Google authorization was declined or failed.",
      );
    }

    const code = callbackUrl.searchParams.get("code");
    const state = callbackUrl.searchParams.get("state");
    if (!code || !state) {
      throw new GoogleOAuthError(
        "invalid_callback",
        "The Google callback is missing code or state.",
      );
    }
    verifySignedOAuthState(state, this.config.stateSecret);

    const body = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
    });

    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new GoogleOAuthError(
        "token_exchange_failed",
        error instanceof Error
          ? `Google token exchange failed: ${error.message}`
          : "Google token exchange failed.",
      );
    }

    let payload: GoogleTokenEndpointResponse;
    try {
      payload = (await response.json()) as GoogleTokenEndpointResponse;
    } catch {
      throw new GoogleOAuthError(
        "token_exchange_failed",
        `Google returned a non-JSON token response (HTTP ${response.status}).`,
      );
    }

    if (!response.ok) {
      throw new GoogleOAuthError(
        optionalString(payload.error) || "token_exchange_failed",
        optionalString(payload.error_description) ||
          `Google token exchange failed with HTTP ${response.status}.`,
      );
    }

    const accessToken = optionalString(payload.access_token);
    if (!accessToken) {
      throw new GoogleOAuthError(
        "token_exchange_failed",
        "Google did not return an access token.",
      );
    }

    return {
      refreshToken: optionalString(payload.refresh_token),
      accessTokenReceived: true,
      expiresInSeconds: optionalPositiveNumber(payload.expires_in),
      grantedScopes: (optionalString(payload.scope) || "")
        .split(/\s+/u)
        .filter(Boolean),
      tokenType: optionalString(payload.token_type),
      idTokenReceived: Boolean(optionalString(payload.id_token)),
    };
  }
}
