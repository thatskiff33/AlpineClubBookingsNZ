import { describe, expect, it } from "vitest";

import {
  MIROTALK_CREDENTIAL_KEYS,
  MIROTALK_PROVIDER,
  MIROTALK_WRITABLE_CREDENTIAL_KEYS,
  isMirotalkCredentialKey,
  parseMirotalkLifetimeSeconds,
  validateMirotalkBaseUrl,
  validateMirotalkTokenLifetime,
} from "@/lib/mirotalk-settings-shared";

/**
 * The rules the setup screen and the API both read (#2940). They live in one
 * module so a value the form accepts is one the route accepts, and the parser
 * the resolver uses is the parser the validator uses — the alternative is a
 * form that is happy with something storage then rejects.
 */

describe("the duration parser", () => {
  it("parses MiroTalk-style durations", () => {
    expect(parseMirotalkLifetimeSeconds("45s")).toBe(45);
    expect(parseMirotalkLifetimeSeconds("30m")).toBe(1800);
    expect(parseMirotalkLifetimeSeconds("1h")).toBe(3600);
    expect(parseMirotalkLifetimeSeconds("1d")).toBe(86400);
    expect(parseMirotalkLifetimeSeconds("900")).toBe(900);
    expect(parseMirotalkLifetimeSeconds(" 2h ")).toBe(7200);
  });

  it("returns null rather than a default for something it cannot read", () => {
    // This is the difference from the old `parseExpiresToSeconds`, which
    // answered 3600 for anything it did not understand. A WRITE has to be able
    // to refuse; only the RESOLVER wants a documented fallback, and it applies
    // one itself.
    expect(parseMirotalkLifetimeSeconds("")).toBeNull();
    expect(parseMirotalkLifetimeSeconds(undefined)).toBeNull();
    expect(parseMirotalkLifetimeSeconds(null)).toBeNull();
    expect(parseMirotalkLifetimeSeconds("soon")).toBeNull();
    expect(parseMirotalkLifetimeSeconds("1 week")).toBeNull();
    expect(parseMirotalkLifetimeSeconds("-5m")).toBeNull();
    expect(parseMirotalkLifetimeSeconds("0h")).toBeNull();
  });
});

describe("validateMirotalkTokenLifetime", () => {
  it("accepts what the documentation shows", () => {
    expect(validateMirotalkTokenLifetime("1h")).toEqual({ ok: true, value: "1h" });
    expect(validateMirotalkTokenLifetime(" 30m ")).toEqual({
      ok: true,
      value: "30m",
    });
  });

  it("refuses a life too short to click, or long enough to forward", () => {
    expect(validateMirotalkTokenLifetime("5s").ok).toBe(false);
    expect(validateMirotalkTokenLifetime("2d").ok).toBe(false);
    expect(validateMirotalkTokenLifetime("1d").ok).toBe(true);
  });

  it("explains itself in plain English", () => {
    const result = validateMirotalkTokenLifetime("soon");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('"1h"');
  });
});

describe("validateMirotalkBaseUrl", () => {
  it("assumes https for a bare host, as the documentation shows it", () => {
    expect(validateMirotalkBaseUrl("meet.example.org")).toEqual({
      ok: true,
      value: "https://meet.example.org",
    });
  });

  it("drops a trailing slash so the join link does not double it", () => {
    expect(validateMirotalkBaseUrl("https://meet.example.org/")).toEqual({
      ok: true,
      value: "https://meet.example.org",
    });
  });

  it("refuses http, because the signed token travels in the address", () => {
    const result = validateMirotalkBaseUrl("http://meet.example.org");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("https://");
  });

  it("refuses credentials embedded in the address", () => {
    expect(validateMirotalkBaseUrl("https://user:pw@meet.example.org").ok).toBe(
      false,
    );
  });

  it("refuses a private, loopback or metadata address", () => {
    // Members' browsers open the link, so a loopback address resolves on
    // whoever clicked it — the exact failure the derived default was changed to
    // stop producing.
    expect(validateMirotalkBaseUrl("https://localhost:3010").ok).toBe(false);
    expect(validateMirotalkBaseUrl("https://127.0.0.1").ok).toBe(false);
    expect(validateMirotalkBaseUrl("https://192.168.1.10").ok).toBe(false);
    expect(validateMirotalkBaseUrl("https://169.254.169.254").ok).toBe(false);
    expect(validateMirotalkBaseUrl("https://meet.internal").ok).toBe(false);
  });

  it("refuses a query string or fragment, which the join link appends itself", () => {
    expect(validateMirotalkBaseUrl("https://meet.example.org?a=1").ok).toBe(false);
    expect(validateMirotalkBaseUrl("https://meet.example.org#x").ok).toBe(false);
  });

  it("refuses an empty or unparseable address", () => {
    expect(validateMirotalkBaseUrl("   ").ok).toBe(false);
    expect(validateMirotalkBaseUrl("https://").ok).toBe(false);
  });

  it("keeps a path, so MiroTalk behind a sub-path still works", () => {
    expect(validateMirotalkBaseUrl("https://example.org/meet/")).toEqual({
      ok: true,
      value: "https://example.org/meet",
    });
  });
});

describe("the credential key set is closed", () => {
  it("names the provider the store rows live under", () => {
    expect(MIROTALK_PROVIDER).toBe("mirotalk");
  });

  it("admits only the three keys, whatever arrives as text", () => {
    expect([...MIROTALK_WRITABLE_CREDENTIAL_KEYS]).toEqual([
      MIROTALK_CREDENTIAL_KEYS.jwtKey,
      MIROTALK_CREDENTIAL_KEYS.meetingUsername,
      MIROTALK_CREDENTIAL_KEYS.meetingPassword,
    ]);
    expect(isMirotalkCredentialKey("jwt_key")).toBe(true);
    expect(isMirotalkCredentialKey("api_key")).toBe(false);
    expect(isMirotalkCredentialKey("")).toBe(false);
    expect(isMirotalkCredentialKey(null)).toBe(false);
    expect(isMirotalkCredentialKey({ toString: () => "jwt_key" })).toBe(false);
  });
});
