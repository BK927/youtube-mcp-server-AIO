import { describe, expect, it } from "vitest";
import { readBearerToken, secretsMatch } from "../src/http/auth.js";

describe("HTTP bearer authentication helpers", () => {
  it("extracts a bearer token case-insensitively", () => {
    expect(readBearerToken("bearer secret-value")).toBe("secret-value");
    expect(readBearerToken("Basic abc")).toBeUndefined();
  });

  it("compares secrets without requiring equal source lengths", () => {
    expect(secretsMatch("same", "same")).toBe(true);
    expect(secretsMatch("short", "a much longer secret")).toBe(false);
    expect(secretsMatch(undefined, "secret")).toBe(false);
  });
});
