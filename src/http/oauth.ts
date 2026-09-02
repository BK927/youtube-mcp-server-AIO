import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Firestore } from "@google-cloud/firestore";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { OAuthRuntimeConfig } from "../runtime-config.js";
import { readRequestBody, sendJson } from "./responses.js";
import { secretsMatch } from "./auth.js";

const CHATGPT_STABLE_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const CHATGPT_STABLE_REDIRECT =
  "https://chatgpt.com/connector_platform_oauth_redirect";
const CHATGPT_SCOPED_CLIENT =
  /^https:\/\/chatgpt\.com\/oauth\/([^/]+)\/client\.json$/u;

interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

interface CodeStore {
  put(code: string, value: AuthorizationCodeRecord): Promise<void>;
  get(code: string): Promise<AuthorizationCodeRecord | undefined>;
  consume(code: string): Promise<AuthorizationCodeRecord | undefined>;
}

class MemoryCodeStore implements CodeStore {
  private readonly values = new Map<string, AuthorizationCodeRecord>();

  async put(code: string, value: AuthorizationCodeRecord): Promise<void> {
    this.values.set(hash(code), { ...value });
  }

  async get(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const value = this.values.get(hash(code));
    return value ? { ...value } : undefined;
  }

  async consume(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const key = hash(code);
    const value = this.values.get(key);
    this.values.delete(key);
    return value ? { ...value } : undefined;
  }
}

class FirestoreCodeStore implements CodeStore {
  private readonly firestore: Firestore;

  constructor(
    projectId: string | undefined,
    private readonly collection: string,
  ) {
    this.firestore = new Firestore(projectId ? { projectId } : undefined);
  }

  private document(code: string) {
    return this.firestore.collection(this.collection).doc(hash(code));
  }

  async put(code: string, value: AuthorizationCodeRecord): Promise<void> {
    await this.document(code).set({
      ...value,
      delete_at: new Date(value.expiresAt * 1_000),
    });
  }

  async get(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const snapshot = await this.document(code).get();
    return snapshot.exists
      ? (snapshot.data() as AuthorizationCodeRecord)
      : undefined;
  }

  async consume(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const document = this.document(code);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(document);
      if (!snapshot.exists) return undefined;
      transaction.delete(document);
      return snapshot.data() as AuthorizationCodeRecord;
    });
  }
}

interface JwtClaims {
  token_use: "authorization_request" | "access" | "refresh";
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  client_id: string;
  scope: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  jti?: string;
  sub?: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function first(form: URLSearchParams, name: string): string {
  return form.get(name)?.trim() || "";
}

function redirectForClient(clientId: string): string | undefined {
  if (clientId === CHATGPT_STABLE_CLIENT_ID) return CHATGPT_STABLE_REDIRECT;
  const match = CHATGPT_SCOPED_CLIENT.exec(clientId);
  return match?.[1]
    ? `https://chatgpt.com/connector/oauth/${match[1]}`
    : undefined;
}

function appendQuery(
  destination: string,
  values: Record<string, string | undefined>,
): string {
  const url = new URL(destination);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.append(key, value);
  }
  return url.toString();
}

function sendRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, {
    "Cache-Control": "no-store",
    Location: location,
    "X-Content-Type-Options": "nosniff",
  });
  response.end();
}

function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

export class PersonalOAuthServer {
  private readonly store: CodeStore;
  private readonly signingSecret: Buffer;

  constructor(private readonly config: OAuthRuntimeConfig) {
    this.signingSecret = Buffer.from(config.signingSecret, "utf8");
    this.store =
      config.store === "firestore"
        ? new FirestoreCodeStore(config.projectId, config.codeCollection)
        : new MemoryCodeStore();
  }

  authorizationMetadata(): Record<string, unknown> {
    return {
      issuer: this.config.issuer,
      authorization_endpoint: `${this.config.issuer}/authorize`,
      token_endpoint: `${this.config.issuer}/token`,
      scopes_supported: [this.config.scope],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.config.resource,
      authorization_servers: [this.config.issuer],
      scopes_supported: [this.config.scope],
      bearer_methods_supported: ["header"],
      resource_name: "YouTube MCP AIO",
    };
  }

  resourceMetadataUrl(): string {
    const resource = new URL(this.config.resource);
    return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
  }

  private sign(claims: JwtClaims): string {
    const header = b64url('{"alg":"HS256","typ":"JWT"}');
    const payload = b64url(JSON.stringify(claims));
    const signature = createHmac("sha256", this.signingSecret)
      .update(`${header}.${payload}`, "utf8")
      .digest("base64url");
    return `${header}.${payload}.${signature}`;
  }

  private verify(
    token: string,
    tokenUse: JwtClaims["token_use"],
  ): JwtClaims | undefined {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return undefined;
      const [header, payload, signature] = parts as [string, string, string];
      const expected = createHmac("sha256", this.signingSecret)
        .update(`${header}.${payload}`, "utf8")
        .digest();
      const supplied = Buffer.from(signature, "base64url");
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        return undefined;
      }
      const claims = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as JwtClaims;
      if (
        claims.token_use !== tokenUse ||
        claims.iss !== this.config.issuer ||
        claims.aud !== this.config.resource ||
        !Number.isSafeInteger(claims.exp) ||
        claims.exp <= Math.floor(Date.now() / 1_000)
      ) {
        return undefined;
      }
      return claims;
    } catch {
      return undefined;
    }
  }

  private issueTokens(clientId: string, scope: string): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1_000);
    const common = {
      iss: this.config.issuer,
      aud: this.config.resource,
      sub: "personal",
      client_id: clientId,
      scope,
      iat: now,
    };
    const accessToken = this.sign({
      ...common,
      token_use: "access",
      exp: now + 3_600,
      jti: randomBytes(16).toString("base64url"),
    });
    const refreshToken = this.sign({
      ...common,
      token_use: "refresh",
      exp: now + 2_592_000,
      jti: randomBytes(16).toString("base64url"),
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3_600,
      scope,
      refresh_token: refreshToken,
    };
  }

  authenticate(token: string): AuthInfo | undefined {
    const claims = this.verify(token, "access");
    if (!claims || !claims.scope.split(/\s+/u).includes(this.config.scope)) {
      return undefined;
    }
    return {
      token,
      clientId: claims.client_id,
      scopes: claims.scope.split(/\s+/u),
      expiresAt: claims.exp,
      extra: {
        authenticationMethod: "oauth2",
        issuer: claims.iss,
        subject: claims.sub,
      },
    };
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    url: URL,
  ): Promise<boolean> {
    if (
      path === "/.well-known/oauth-authorization-server" &&
      request.method === "GET"
    ) {
      sendJson(response, 200, this.authorizationMetadata());
      return true;
    }
    if (
      [
        "/.well-known/oauth-protected-resource",
        new URL(this.resourceMetadataUrl()).pathname,
      ].includes(path) &&
      request.method === "GET"
    ) {
      sendJson(response, 200, this.protectedResourceMetadata());
      return true;
    }
    if (path === "/authorize" && request.method === "GET") {
      this.authorize(response, url);
      return true;
    }
    if (path === "/oauth/login" && ["GET", "POST"].includes(request.method || "")) {
      await this.login(request, response, url);
      return true;
    }
    if (path === "/token" && request.method === "POST") {
      await this.token(request, response);
      return true;
    }
    return false;
  }

  private authorize(response: ServerResponse, url: URL): void {
    const clientId = url.searchParams.get("client_id") || "";
    const registeredRedirect = redirectForClient(clientId);
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const responseType = url.searchParams.get("response_type");
    const challenge = url.searchParams.get("code_challenge") || "";
    const challengeMethod = url.searchParams.get("code_challenge_method");
    const resource = url.searchParams.get("resource") || "";
    const requestedScope = url.searchParams.get("scope") || this.config.scope;
    if (
      !registeredRedirect ||
      redirectUri !== registeredRedirect ||
      responseType !== "code" ||
      challengeMethod !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/u.test(challenge) ||
      resource !== this.config.resource ||
      requestedScope.split(/\s+/u).some((scope) => scope !== this.config.scope)
    ) {
      sendJson(response, 400, {
        error: "invalid_request",
        error_description: "The OAuth authorization request is invalid.",
      });
      return;
    }
    const now = Math.floor(Date.now() / 1_000);
    const state = url.searchParams.get("state") || undefined;
    const transaction = this.sign({
      token_use: "authorization_request",
      iss: this.config.issuer,
      aud: this.config.resource,
      iat: now,
      exp: now + 300,
      client_id: clientId,
      scope: requestedScope,
      redirect_uri: redirectUri,
      ...(state ? { state } : {}),
      code_challenge: challenge,
    });
    sendRedirect(
      response,
      `${this.config.issuer}/oauth/login?${new URLSearchParams({ transaction })}`,
    );
  }

  private async login(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    let transaction = url.searchParams.get("transaction") || "";
    let error = "";
    if (request.method === "POST") {
      const form = new URLSearchParams(await readRequestBody(request, 16_384));
      transaction = first(form, "transaction");
      if (!secretsMatch(first(form, "access_key"), this.config.loginSecret)) {
        error = "The access key was not accepted.";
      } else {
        const claims = this.verify(transaction, "authorization_request");
        if (!claims?.redirect_uri || !claims.code_challenge) {
          sendJson(response, 400, { error: "invalid_authorization_request" });
          return;
        }
        const code = randomBytes(32).toString("base64url");
        await this.store.put(code, {
          clientId: claims.client_id,
          redirectUri: claims.redirect_uri,
          codeChallenge: claims.code_challenge,
          scope: claims.scope,
          resource: this.config.resource,
          expiresAt: Math.floor(Date.now() / 1_000) + 300,
        });
        sendRedirect(
          response,
          appendQuery(claims.redirect_uri, {
            code,
            state: claims.state,
            iss: this.config.issuer,
          }),
        );
        return;
      }
    }
    if (!this.verify(transaction, "authorization_request")) {
      sendJson(response, 400, { error: "invalid_authorization_request" });
      return;
    }
    const errorHtml = error
      ? `<p class="error">${escapeHtml(error)}</p>`
      : "";
    sendHtml(
      response,
      error ? 401 : 200,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect YouTube MCP</title><style>body{font:16px system-ui;max-width:32rem;margin:12vh auto;padding:1.5rem;color:#17202a}input,button{box-sizing:border-box;width:100%;padding:.8rem;margin:.4rem 0}button{cursor:pointer}.error{color:#b42318}</style></head><body><h1>Connect YouTube MCP</h1><p>Enter the private access key for this personal server.</p>${errorHtml}<form method="post" action="/oauth/login"><input type="hidden" name="transaction" value="${escapeHtml(transaction)}"><label>Access key<input type="password" name="access_key" autocomplete="current-password" required autofocus></label><button type="submit">Authorize ChatGPT</button></form></body></html>`,
    );
  }

  private async token(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const form = new URLSearchParams(await readRequestBody(request, 16_384));
    const clientId = first(form, "client_id");
    if (!redirectForClient(clientId)) {
      sendJson(response, 401, { error: "invalid_client" });
      return;
    }
    const grantType = first(form, "grant_type");
    if (grantType === "authorization_code") {
      const code = first(form, "code");
      const record = await this.store.get(code);
      const verifier = first(form, "code_verifier");
      const challenge = createHash("sha256")
        .update(verifier, "utf8")
        .digest("base64url");
      if (
        !record ||
        record.clientId !== clientId ||
        record.redirectUri !== first(form, "redirect_uri") ||
        record.resource !== first(form, "resource") ||
        record.expiresAt <= Math.floor(Date.now() / 1_000) ||
        !secretsMatch(challenge, record.codeChallenge)
      ) {
        sendJson(response, 400, { error: "invalid_grant" });
        return;
      }
      const consumed = await this.store.consume(code);
      if (!consumed) {
        sendJson(response, 400, { error: "invalid_grant" });
        return;
      }
      sendJson(response, 200, this.issueTokens(clientId, record.scope));
      return;
    }
    if (grantType === "refresh_token") {
      const claims = this.verify(first(form, "refresh_token"), "refresh");
      const resource = first(form, "resource") || this.config.resource;
      if (
        !claims ||
        claims.client_id !== clientId ||
        resource !== this.config.resource
      ) {
        sendJson(response, 400, { error: "invalid_grant" });
        return;
      }
      const scope = first(form, "scope") || claims.scope;
      if (scope.split(/\s+/u).some((item) => !claims.scope.split(/\s+/u).includes(item))) {
        sendJson(response, 400, { error: "invalid_scope" });
        return;
      }
      sendJson(response, 200, this.issueTokens(clientId, scope));
      return;
    }
    sendJson(response, 400, { error: "unsupported_grant_type" });
  }
}
