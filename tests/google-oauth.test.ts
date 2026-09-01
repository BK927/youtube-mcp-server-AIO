import { describe, expect, it, vi } from "vitest";
import {
  GoogleOAuthError,
  GoogleOAuthManager,
  createSignedOAuthState,
  verifySignedOAuthState,
} from "../src/oauth/google-oauth.js";

const STATE_SECRET = "state-secret-".repeat(4);

function createManager(fetchImpl: typeof fetch = fetch): GoogleOAuthManager {
  return new GoogleOAuthManager(
    {
      clientId: "client.apps.googleusercontent.com",
      clientSecret: "client-secret",
      stateSecret: STATE_SECRET,
      redirectUri: "https://example.run.app/oauth/google/callback",
      scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
      stateTtlSeconds: 600,
      requestTimeoutMs: 5_000,
    },
    fetchImpl,
  );
}

describe("Google OAuth helper", () => {
  it("signs, verifies, and expires stateless OAuth state", () => {
    const state = createSignedOAuthState(STATE_SECRET, 600, 1_000);
    const payload = verifySignedOAuthState(state, STATE_SECRET, 1_200);
    expect(payload.version).toBe(1);
    expect(payload.expiresAt).toBe(1_600);

    expect(() => verifySignedOAuthState(`${state}x`, STATE_SECRET, 1_200)).toThrow(
      GoogleOAuthError,
    );
    expect(() => verifySignedOAuthState(state, STATE_SECRET, 1_601)).toThrow(
      /expired/u,
    );
  });

  it("builds an offline-consent authorization URL with the exact redirect", () => {
    const url = new URL(createManager().createAuthorizationUrl());
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.run.app/oauth/google/callback",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("exchanges a valid callback without exposing the short-lived access token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("code")).toBe("authorization-code");
      expect(body.get("redirect_uri")).toBe(
        "https://example.run.app/oauth/google/callback",
      );
      return new Response(
        JSON.stringify({
          access_token: "access-token-that-must-not-be-returned",
          refresh_token: "refresh-token",
          expires_in: 3_600,
          scope: "scope-a scope-b",
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const manager = createManager(fetchMock);
    const authorizationUrl = new URL(manager.createAuthorizationUrl());
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = new URL("https://example.run.app/oauth/google/callback");
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", state!);

    const grant = await manager.exchangeCallback(callback);
    expect(grant).toEqual({
      refreshToken: "refresh-token",
      accessTokenReceived: true,
      expiresInSeconds: 3_600,
      grantedScopes: ["scope-a", "scope-b"],
      tokenType: "Bearer",
      idTokenReceived: false,
    });
    expect(JSON.stringify(grant)).not.toContain(
      "access-token-that-must-not-be-returned",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
