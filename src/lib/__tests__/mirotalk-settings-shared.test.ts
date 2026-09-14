import { describe, expect, it } from "vitest";

import {
  MIROTALK_CREDENTIAL_KEYS,
  MIROTALK_PROVIDER,
  MIROTALK_WRITABLE_CREDENTIAL_KEYS,
  isMirotalkCredentialKey,
  isSameMeetingServer,
  mirotalkSecretsAtRiskFromAddressChange,
  parseMirotalkLifetimeSeconds,
  stripTrailingSlashes,
  validateMirotalkBaseUrl,
  validateMirotalkTokenLifetime,
  withAssumedHttpsScheme,
} from "@/lib/mirotalk-settings-shared";
import {
  isBlockedDestinationHost,
  isLoopbackDestinationHost,
} from "@/lib/private-destination-hosts";

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

  it.each([
    ["cloud metadata with the root label", "https://metadata.google.internal."],
    ["mDNS with the root label", "https://nas.local."],
    ["a private-zone name with the root label", "https://vault.internal."],
  ])("refuses %s as a private host", (_label, url) => {
    // A TRAILING DOT IS THE DNS ROOT LABEL, and the URL parser preserves it
    // verbatim on a NAME (it strips one from an IP literal, which is why the
    // literal rules looked fine and the name rules did not). These resolve
    // exactly where the dotless spellings do, and before the root label was
    // stripped they passed every name-based rule here.
    const result = validateMirotalkBaseUrl(url);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/private, loopback or link-local/i);
  });

  it.each([
    ["loopback with the DNS root label", "https://localhost."],
    ["loopback with two root labels", "https://localhost.."],
  ])("refuses %s", (_label, url) => {
    // Refused, but by the DOMAIN rule rather than the private-host one, because
    // `localhost.` strips to the single label `localhost`. Both rules now read
    // the stripped host, so the order between them decides only which sentence
    // the administrator is shown; what matters is that neither can be turned
    // off with a dot. Before the fix this stored cleanly: the trailing dot
    // satisfied "needs a domain" and the private-host rule never saw a match.
    expect(validateMirotalkBaseUrl(url).ok).toBe(false);
  });

  it("still refuses a single label that is only wearing a root label", () => {
    // `meet.` is the same single label as `meet`, so the domain rule has to be
    // asked of the stripped host too — otherwise the trailing dot reads as a
    // domain separator and a typed fragment stores cleanly.
    const result = validateMirotalkBaseUrl("https://meet.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/needs a domain/i);
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

describe("the one scheme test (#2940 review, T5)", () => {
  it("assumes https for a bare host", () => {
    expect(withAssumedHttpsScheme("meet.example.org")).toBe(
      "https://meet.example.org",
    );
    expect(withAssumedHttpsScheme("meet.example.org/a")).toBe(
      "https://meet.example.org/a",
    );
  });

  it("leaves an address that already carries ANY scheme alone", () => {
    // The drift this replaced: `/^https?:\/\//` accepted only two schemes, so
    // the resolver bolted https onto `ftp://…` and produced
    // `https://ftp://meet.example.org`, which the validator then refused with
    // "it needs a domain" rather than with the real reason.
    for (const value of [
      "https://meet.example.org",
      "http://meet.example.org",
      "ftp://meet.example.org",
      "ws+unix://meet.example.org",
    ]) {
      expect(withAssumedHttpsScheme(value)).toBe(value);
    }
  });

  it("gives an ftp address the reason it was actually refused for", () => {
    const result = validateMirotalkBaseUrl("ftp://meet.example.org");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/https:\/\//);
    expect(result.reason).not.toMatch(/needs a domain/i);
  });
});

describe("the one trailing-slash rule (#2940 review, T7)", () => {
  it("drops every trailing slash and nothing else", () => {
    expect(stripTrailingSlashes("https://meet.example.org///")).toBe(
      "https://meet.example.org",
    );
    expect(stripTrailingSlashes("https://meet.example.org/a")).toBe(
      "https://meet.example.org/a",
    );
    expect(stripTrailingSlashes("https://meet.example.org")).toBe(
      "https://meet.example.org",
    );
  });
});

describe("is it the same meeting server? (#2940 review, C1)", () => {
  // The question that decides whether three unreadable secrets are destroyed.
  // The two sides arrive by different routes — one parsed, one deliberately not
  // — so it has to see past a spelling difference.
  it.each([
    ["a bare host against the https form", "meet.club.org", "https://meet.club.org"],
    ["a trailing slash", "https://meet.club.org/", "https://meet.club.org"],
    ["the default port written out", "https://meet.club.org:443", "https://meet.club.org"],
    ["a capitalised host", "https://MEET.club.org", "https://meet.club.org"],
  ])("treats %s as the same server", (_label, a, b) => {
    expect(isSameMeetingServer(a, b)).toBe(true);
  });

  it.each([
    ["a different host", "https://meet.club.org", "https://meet.elsewhere.org"],
    ["a different path", "https://meet.club.org/a", "https://meet.club.org/b"],
    ["a non-default port", "https://meet.club.org:8443", "https://meet.club.org"],
  ])("treats %s as a move", (_label, a, b) => {
    expect(isSameMeetingServer(a, b)).toBe(false);
  });
});

describe("the one loopback rule (#2940 review, T2)", () => {
  it.each([
    ["localhost", "localhost"],
    ["localhost with the DNS root label", "localhost."],
    ["a localhost subdomain", "app.localhost"],
    ["loopback 127.0.0.1", "127.0.0.1"],
    ["anywhere else in loopback/8", "127.0.0.2"],
    ["the unspecified IPv4 address", "0.0.0.0"],
    ["IPv6 loopback", "::1"],
    ["IPv6 loopback, bracketed", "[::1]"],
    ["the unspecified IPv6 address", "::"],
    ["an IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["a host of nothing but dots", "."],
  ])("reads %s as this machine", (_label, host) => {
    // The four the private copy in mirotalk-config.ts missed — `localhost.`,
    // `127.0.0.2`, `0.0.0.0` and `::` — are why there is one rule now. The
    // visible symptom was NEXTAUTH_URL=http://localhost.:3000 deriving the
    // meeting address `https://meet.localhost.` instead of the dev fallback.
    expect(isLoopbackDestinationHost(host)).toBe(true);
  });

  it.each([
    ["a public host", "meet.example.org"],
    ["a private RFC1918 address", "192.168.1.10"],
    ["a CGNAT address", "100.64.0.1"],
    ["cloud metadata", "169.254.169.254"],
    ["an IPv4-mapped private address", "::ffff:10.0.0.1"],
  ])("does NOT read %s as this machine", (_label, host) => {
    // Private-but-elsewhere is not this machine. `isBlockedDestinationHost` is
    // the rule for "may an administrator send us here"; this one answers "is the
    // app's own origin local", and conflating them would be the behaviour change
    // the review explicitly ruled out.
    expect(isLoopbackDestinationHost(host)).toBe(false);
  });

  it("is a strict SUBSET of the blocked-destination rule", () => {
    // Asserted rather than claimed: anything local must also be refused as a
    // destination an administrator may type.
    const hosts = [
      "localhost",
      "localhost.",
      "app.localhost",
      "127.0.0.1",
      "127.0.0.2",
      "0.0.0.0",
      "::1",
      "[::1]",
      "::",
      "::ffff:127.0.0.1",
      ".",
      "",
      "meet.example.org",
      "192.168.1.10",
      "10.0.0.1",
      "172.16.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "224.0.0.1",
      "vault.internal",
      "printer.local",
      "fd00::1",
      "fe80::1",
    ];
    for (const host of hosts) {
      if (isLoopbackDestinationHost(host)) {
        expect([host, isBlockedDestinationHost(host)]).toEqual([host, true]);
      }
    }
  });
});

describe("warning BEFORE the save, not after (#2940 review, S7)", () => {
  const secret = (
    key: (typeof MIROTALK_WRITABLE_CREDENTIAL_KEYS)[number],
    source: "database" | "environment" | "unset",
  ) => ({ key, source, version: null, updatedAt: null, needsReentry: false });

  const STORED_SECRETS = [
    secret(MIROTALK_CREDENTIAL_KEYS.jwtKey, "database"),
    secret(MIROTALK_CREDENTIAL_KEYS.meetingUsername, "database"),
    secret(MIROTALK_CREDENTIAL_KEYS.meetingPassword, "database"),
  ];
  const IN_FORCE_FROM_ENV = {
    effective: "https://meet.club.org",
    source: "environment" as const,
    problem: null,
  };
  const IN_FORCE_FROM_PAGE = {
    effective: "https://meet.club.org",
    source: "database" as const,
    problem: null,
  };

  it("warns about nothing when the box only writes down the address in force", () => {
    // The C1 case seen from the page: the admin is moving off the environment
    // file, which is what the documentation asks for, and nothing is deleted.
    expect(
      mirotalkSecretsAtRiskFromAddressChange({
        secrets: STORED_SECRETS,
        inForce: IN_FORCE_FROM_ENV,
        draftBaseUrl: "meet.club.org",
      }),
    ).toEqual([]);
  });

  it("names every stored secret when the address really moves", () => {
    expect(
      mirotalkSecretsAtRiskFromAddressChange({
        secrets: STORED_SECRETS,
        inForce: IN_FORCE_FROM_ENV,
        draftBaseUrl: "https://meet.elsewhere.org",
      }),
    ).toEqual([
      MIROTALK_CREDENTIAL_KEYS.jwtKey,
      MIROTALK_CREDENTIAL_KEYS.meetingUsername,
      MIROTALK_CREDENTIAL_KEYS.meetingPassword,
    ]);
  });

  it("names only the secrets that are actually STORED here", () => {
    // An environment secret is not in the store, so the clear cannot touch it
    // and warning about it would be false.
    expect(
      mirotalkSecretsAtRiskFromAddressChange({
        secrets: [
          secret(MIROTALK_CREDENTIAL_KEYS.jwtKey, "database"),
          secret(MIROTALK_CREDENTIAL_KEYS.meetingUsername, "environment"),
          secret(MIROTALK_CREDENTIAL_KEYS.meetingPassword, "unset"),
        ],
        inForce: IN_FORCE_FROM_ENV,
        draftBaseUrl: "https://meet.elsewhere.org",
      }),
    ).toEqual([MIROTALK_CREDENTIAL_KEYS.jwtKey]);
  });

  it("warns when the box is cleared and the box is what governs today", () => {
    expect(
      mirotalkSecretsAtRiskFromAddressChange({
        secrets: STORED_SECRETS,
        inForce: IN_FORCE_FROM_PAGE,
        draftBaseUrl: "",
      }),
    ).toHaveLength(3);
  });

  it("does not warn when the box is cleared and was already empty", () => {
    expect(
      mirotalkSecretsAtRiskFromAddressChange({
        secrets: STORED_SECRETS,
        inForce: IN_FORCE_FROM_ENV,
        draftBaseUrl: "   ",
      }),
    ).toEqual([]);
  });

  it("warns about nothing when nothing is stored here to lose", () => {
    expect(
      mirotalkSecretsAtRiskFromAddressChange({
        secrets: [
          secret(MIROTALK_CREDENTIAL_KEYS.jwtKey, "environment"),
          secret(MIROTALK_CREDENTIAL_KEYS.meetingUsername, "unset"),
          secret(MIROTALK_CREDENTIAL_KEYS.meetingPassword, "unset"),
        ],
        inForce: IN_FORCE_FROM_ENV,
        draftBaseUrl: "https://meet.elsewhere.org",
      }),
    ).toEqual([]);
  });

  it("warns on a half-typed address rather than staying quiet", () => {
    // Mid-edit the draft does not validate. The conservative answer is the
    // warning: it is removed as soon as the address resolves to the same
    // server, and being told about a deletion that then does not happen is a
    // far cheaper mistake than the reverse.
    expect(
      mirotalkSecretsAtRiskFromAddressChange({
        secrets: STORED_SECRETS,
        inForce: IN_FORCE_FROM_ENV,
        draftBaseUrl: "https://meet.cl",
      }),
    ).toHaveLength(3);
  });
});
