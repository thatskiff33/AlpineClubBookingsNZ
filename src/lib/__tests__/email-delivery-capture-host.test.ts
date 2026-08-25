import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A capture declaration contradicted by its own host (#3071 external review;
 * epic #2986; INV-CONFIG-004).
 *
 * `USE_LOCAL_CAPTURE=true` declares that `EMAIL_SERVER_HOST` is a sink that
 * forwards nothing, and that declaration is what lets a confirmed copy transmit
 * at all. The two settings were read as one pair with nothing checking them
 * against each other, so an installation that ALREADY had `USE_SMTP_RELAY=true`
 * working against a real relay and simply flipped the flag — which is what both
 * of our own repair strings told it to do — kept the live relay host. The policy
 * answered `allow` with grounds `non-production-capture`, the relay delivered to
 * real members, and the log recorded that the message had reached nobody.
 *
 * WHAT THIS FILE PINS, and the shape matters as much as the outcome:
 *
 * 1. Every host form a REAL capture stack in this repository uses is accepted.
 *    That is not a nicety — `EMAIL_SERVER_HOST=mailpit` is what the browser
 *    suite, `.env.staging.example` and the measurement stack all set, and a rule
 *    that only accepted loopback and RFC 1918 literals would have refused all
 *    three while looking correct in review.
 * 2. A public host is refused, and refused as its OWN outcome rather than folded
 *    into a neighbour, because each outcome carries a different operator remedy.
 * 3. The refusal reaches the VERIFY path too, so the health check and the setup
 *    wizard's SMTP test do not report a working connection that every send then
 *    blocks.
 * 4. The escape hatch works, and unrecognised input fails closed.
 */

const mocks = vi.hoisted(() => ({
  environmentSafetyFindUnique: vi.fn(),
  createTransport: vi.fn(),
  verify: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: { findUnique: mocks.environmentSafetyFindUnique },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));

import {
  CAPTURE_ALLOW_PUBLIC_HOST_FLAG,
  classifyCaptureHost,
  emailTransportKindOf,
  refuseAmbiguousImplicitSesDefault,
  resolveEmailDeliveryConfigFromEnv,
} from "@/lib/email-delivery";
import {
  decideDeliveryPolicy,
  describeDeliveryDecision,
  resolveDeliveryPolicy,
} from "@/lib/environment-delivery-policy";
import { verifyEmailTransport } from "@/lib/email/internal";
import {
  declareEnvironmentRole,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";

/** A complete capture configuration bar the host, which each case supplies. */
function captureEnv(host: string, extra: Record<string, string> = {}) {
  return {
    EMAIL_FROM: "club@club.test",
    USE_LOCAL_CAPTURE: "true",
    EMAIL_SERVER_HOST: host,
    EMAIL_SERVER_PORT: "1025",
    EMAIL_SERVER_USER: "capture",
    EMAIL_SERVER_PASSWORD: "capture-only",
    ...extra,
  };
}

const NON_PRODUCTION_COPY = {
  role: "NON_PRODUCTION",
  decidedBy: "deployment-declaration",
  declaration: { kind: "non-production" },
  databaseOverride: { kind: "none" },
  notes: [],
} as unknown as Parameters<typeof decideDeliveryPolicy>[0];

const LIVE_SITE = {
  role: "PRODUCTION",
  decidedBy: "deployment-declaration",
  declaration: { kind: "production" },
  databaseOverride: { kind: "none" },
  notes: [],
} as unknown as Parameters<typeof decideDeliveryPolicy>[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  undeclareEnvironmentRole();
  mocks.environmentSafetyFindUnique.mockResolvedValue(null);
  mocks.verify.mockResolvedValue(true);
  mocks.createTransport.mockReturnValue({ verify: mocks.verify });
});

describe("classifyCaptureHost accepts the capture hosts this repository really uses", () => {
  /**
   * THE CASE THAT DECIDES THE WHOLE DESIGN. The obvious rule — "loopback or
   * RFC 1918 only" — refuses `mailpit`, and `mailpit` is what
   * `.github/workflows/e2e.yml`, `.env.staging.example`,
   * `docker-compose.staging.yml` and `measurement/stack/` all set. A check that
   * breaks every capture stack in the repository is not a safer check, it is a
   * broken one that would have been reverted rather than fixed.
   */
  it.each([
    ["mailpit", "the browser suite's and the measurement stack's capture"],
    ["mailhog", "the other common sink container"],
    ["smtp", "a bare service name"],
    ["localhost", "a developer's laptop"],
    ["127.0.0.1", "loopback"],
    ["10.0.0.5", "RFC 1918"],
    ["172.16.4.9", "RFC 1918, the awkward middle range"],
    ["172.31.255.254", "RFC 1918, the top of that range"],
    ["192.168.1.25", "RFC 1918"],
    ["169.254.10.1", "link-local"],
    ["100.64.0.1", "RFC 6598 shared address space"],
    ["::1", "IPv6 loopback"],
    ["[fd00::1]", "IPv6 unique-local, bracketed"],
    ["fe80::abcd", "IPv6 link-local"],
    ["mail.internal", "a reserved suffix"],
    ["sink.home.arpa", "RFC 8375"],
    ["mailpit.test", "RFC 6761"],
    ["capture.localhost", "RFC 6761"],
    ["MAILPIT", "case is irrelevant"],
    ["  mailpit  ", "surrounding space is irrelevant"],
    ["mailpit.", "a trailing root dot is irrelevant"],
  ])("accepts %s (%s)", (host) => {
    expect(classifyCaptureHost(host)).toBe("private-address");
  });
});

describe("classifyCaptureHost refuses hosts that can deliver to a real member", () => {
  /**
   * The first two are the actual upgrade hazard: a deployment that had
   * `USE_SMTP_RELAY` working names one of these, and flipping the capture flag
   * used to inherit it wholesale.
   */
  it.each([
    ["email-smtp.ap-southeast-2.amazonaws.com", "the AWS SES default host"],
    ["smtp.sendgrid.net", "a real relay"],
    ["mail.myclub.co.nz", "a club's own public mail host"],
    ["8.8.8.8", "a public address"],
    ["172.32.0.1", "just outside RFC 1918"],
    ["172.15.255.255", "just below RFC 1918"],
    ["192.169.1.1", "one octet off RFC 1918"],
    ["100.128.0.1", "just outside RFC 6598"],
    ["11.0.0.1", "adjacent to the RFC 1918 /8"],
    ["2606:4700::1111", "a public IPv6 address"],
    ["mailpit.example.com", "a real domain that merely starts with a sink name"],
    ["", "no host at all"],
    ["not an address", "unparseable"],
    ["192.168.1", "a malformed dotted quad"],
    ["999.1.1.1", "an out-of-range octet, so not an IPv4 literal at all"],
  ])("refuses %s (%s)", (host) => {
    expect(classifyCaptureHost(host)).toBe("public-address");
  });

  /**
   * The boundaries above are asserted from both sides on purpose. A rule written
   * `b >= 16 && b <= 32` or `a === 172` alone still passes every accepted case,
   * so only the just-outside cases can fail it.
   */
  it("treats the RFC 1918 172.16/12 range as exactly twelve bits", () => {
    expect(classifyCaptureHost("172.16.0.0")).toBe("private-address");
    expect(classifyCaptureHost("172.31.0.0")).toBe("private-address");
    expect(classifyCaptureHost("172.15.0.0")).toBe("public-address");
    expect(classifyCaptureHost("172.32.0.0")).toBe("public-address");
  });
});

describe("the parser refuses a capture declared against a public host", () => {
  it("names EMAIL_SERVER_HOST, offers both repairs, and holds no transport", () => {
    const config = resolveEmailDeliveryConfigFromEnv(
      captureEnv("smtp.sendgrid.net"),
    );

    expect(config.ok).toBe(false);
    expect(config.captureHost).toBe("public-address");
    // No transport options at all: nothing downstream can open a connection to
    // the relay even if it ignored `ok`.
    expect(config.transportOptions).toBeNull();
    const issue = config.issues.join(" ");
    expect(issue).toContain("EMAIL_SERVER_HOST");
    expect(issue).toContain("USE_SMTP_RELAY=true");
    expect(issue).toContain(CAPTURE_ALLOW_PUBLIC_HOST_FLAG);
    // The refusal must not echo the configured host back into an operator
    // surface or a log line.
    expect(issue).not.toContain("sendgrid");
  });

  it("reports its own transport kind rather than borrowing another's", () => {
    const refused = resolveEmailDeliveryConfigFromEnv(
      captureEnv("smtp.sendgrid.net"),
    );
    expect(emailTransportKindOf(refused)).toBe("capture-public-host");

    // Not `unresolved`, which means "nobody configured a transport" and would
    // send this operator to fix the flags they set correctly.
    expect(emailTransportKindOf(refused)).not.toBe("unresolved");
    // And not `local-capture`, which is the exemption being refused.
    expect(emailTransportKindOf(refused)).not.toBe("local-capture");
  });

  it("accepts the same configuration once the host is the capture", () => {
    const config = resolveEmailDeliveryConfigFromEnv(captureEnv("mailpit"));
    expect(config.ok).toBe(true);
    expect(config.captureHost).toBe("private-address");
    expect(config.transportOptions).toEqual({
      host: "mailpit",
      port: 1025,
      secure: false,
      auth: { user: "capture", pass: "capture-only" },
    });
    expect(emailTransportKindOf(config)).toBe("local-capture");
  });

  it("leaves an ordinary SMTP relay's host entirely alone", () => {
    // A relay is classified a LIVE provider however it is configured, so its
    // host is none of this rule's business — checking it would be the inference
    // the module forbids.
    const config = resolveEmailDeliveryConfigFromEnv({
      EMAIL_FROM: "club@club.test",
      USE_SMTP_RELAY: "true",
      EMAIL_SERVER_HOST: "smtp.sendgrid.net",
      EMAIL_SERVER_PORT: "587",
      EMAIL_SERVER_USER: "relay",
      EMAIL_SERVER_PASSWORD: "secret",
    });
    expect(config.ok).toBe(true);
    expect(config.captureHost).toBe("not-applicable");
    expect(emailTransportKindOf(config)).toBe("live-provider");
  });
});

describe("the escape hatch is explicit, and only an explicit true", () => {
  it("permits a public host when the operator declares the flag", () => {
    const config = resolveEmailDeliveryConfigFromEnv(
      captureEnv("mailpit.myclub.co.nz", {
        [CAPTURE_ALLOW_PUBLIC_HOST_FLAG]: "true",
      }),
    );
    expect(config.ok).toBe(true);
    expect(config.captureHost).toBe("operator-declared-public");
    expect(emailTransportKindOf(config)).toBe("local-capture");
  });

  it.each([["false"], ["yes"], ["1"], [""], ["  "]])(
    "does not accept %o as the declaration",
    (value) => {
      const config = resolveEmailDeliveryConfigFromEnv(
        captureEnv("smtp.sendgrid.net", {
          [CAPTURE_ALLOW_PUBLIC_HOST_FLAG]: value,
        }),
      );
      expect(config.ok).toBe(false);
      expect(config.captureHost).toBe("public-address");
    },
  );

  it("keeps the verdict apart from a verified private address", () => {
    // Two different amounts of evidence: one was checked, the other is a
    // person's word. An operator surface that showed them as one would be
    // overstating the second.
    expect(
      resolveEmailDeliveryConfigFromEnv(captureEnv("mailpit")).captureHost,
    ).toBe("private-address");
    expect(
      resolveEmailDeliveryConfigFromEnv(
        captureEnv("mailpit.myclub.co.nz", {
          [CAPTURE_ALLOW_PUBLIC_HOST_FLAG]: "true",
        }),
      ).captureHost,
    ).toBe("operator-declared-public");
  });
});

describe("the delivery policy refuses it, distinguishably", () => {
  it("blocks a copy whose capture host is public", () => {
    expect(
      decideDeliveryPolicy(NON_PRODUCTION_COPY, "capture-public-host"),
    ).toEqual({ kind: "block_capture_public_host" });
  });

  it("still allows a copy whose capture host is the capture", () => {
    expect(decideDeliveryPolicy(NON_PRODUCTION_COPY, "local-capture")).toEqual({
      kind: "allow",
      grounds: "non-production-capture",
    });
  });

  /**
   * The live site is refused for BEING a live site in capture mode, whatever the
   * host turned out to be. Reporting the host problem there would send the
   * operator of the club's live site off to fix `EMAIL_SERVER_HOST` when the
   * capture declaration itself is the fault.
   */
  it("reports capture-in-production on the live site, not the host problem", () => {
    expect(decideDeliveryPolicy(LIVE_SITE, "capture-public-host")).toEqual({
      kind: "block_capture_in_production",
    });
    expect(decideDeliveryPolicy(LIVE_SITE, "local-capture")).toEqual({
      kind: "block_capture_in_production",
    });
  });

  it("mints no clearance for the refused configuration", async () => {
    declareEnvironmentRole("non-production");
    vi.stubEnv("USE_LOCAL_CAPTURE", "true");
    vi.stubEnv("EMAIL_SERVER_HOST", "smtp.sendgrid.net");
    vi.stubEnv("EMAIL_SERVER_PORT", "587");
    vi.stubEnv("EMAIL_SERVER_USER", "capture");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "capture-only");
    vi.stubEnv("EMAIL_FROM", "club@club.test");

    const decision = await resolveDeliveryPolicy();
    expect(decision.kind).toBe("block_capture_public_host");
    expect(decision).not.toHaveProperty("clearance");
  });

  it("tells the operator which setting to change, and offers the alternative", () => {
    const message = describeDeliveryDecision({
      kind: "block_capture_public_host",
    });
    expect(message).toContain("EMAIL_SERVER_HOST");
    expect(message).toContain("USE_SMTP_RELAY=true");
    expect(message).toContain(CAPTURE_ALLOW_PUBLIC_HOST_FLAG);
    // Distinguishable from the live-site capture refusal by more than a word.
    expect(message).not.toEqual(
      describeDeliveryDecision({ kind: "block_capture_in_production" }),
    );
  });

  /**
   * THE FALSE CLAIM THIS REVIEW FOUND. The capture-allow sentence used to end
   * "and can reach nobody outside it" — written into the log of a message that
   * had just been delivered to a real member by an inherited relay.
   *
   * It must not swing to the opposite overclaim either: the check cannot prove
   * onward forwarding, and an operator using the escape hatch has overridden it,
   * so the sentence may not say the host was vetted.
   */
  it("no longer claims a capture send reached nobody", () => {
    const message = describeDeliveryDecision({
      kind: "allow",
      grounds: "non-production-capture",
    });
    expect(message).not.toContain("can reach nobody");
    expect(message).toContain("EMAIL_SERVER_HOST");
    // Attributed to the deployment's declaration rather than asserted as fact.
    expect(message).toContain("declares");
    expect(message).toContain("not something this application can verify");
  });
});

describe("the verify path refuses it too", () => {
  /**
   * The health check and the setup wizard's SMTP test read `ok`/`issues`. Without
   * this, an operator would be told the connection was fine while every send was
   * blocked — the claim-versus-reality gap this epic exists to close.
   */
  it("does not open a connection to a public host declared as a capture", async () => {
    declareEnvironmentRole("non-production");
    vi.stubEnv("USE_LOCAL_CAPTURE", "true");
    vi.stubEnv("EMAIL_SERVER_HOST", "smtp.sendgrid.net");
    vi.stubEnv("EMAIL_SERVER_PORT", "587");
    vi.stubEnv("EMAIL_SERVER_USER", "capture");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "capture-only");
    vi.stubEnv("EMAIL_FROM", "club@club.test");

    await expect(verifyEmailTransport()).rejects.toThrow(/EMAIL_SERVER_HOST/);
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("still verifies a genuine capture", async () => {
    declareEnvironmentRole("non-production");
    vi.stubEnv("USE_LOCAL_CAPTURE", "true");
    vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
    vi.stubEnv("EMAIL_SERVER_PORT", "1025");
    vi.stubEnv("EMAIL_SERVER_USER", "capture");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "capture-only");
    vi.stubEnv("EMAIL_FROM", "club@club.test");

    await expect(verifyEmailTransport()).resolves.toEqual({
      modeLabel: "Local capture mailbox",
    });
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });
});

describe("the ambiguous-transport repair string names the host", () => {
  /**
   * Following the old advice was how the defect was reached: it said to declare
   * `USE_LOCAL_CAPTURE=true` and stopped there, which reads as one flag flip to
   * an operator who already has a working relay. This string is the only thing
   * an operator sees on the verify path.
   */
  it("tells an operator to move EMAIL_SERVER_HOST as well as set the flag", () => {
    const flagless = resolveEmailDeliveryConfigFromEnv({
      EMAIL_FROM: "club@club.test",
    });
    expect(flagless.modeSource).toBe("implicit-legacy-default");

    // The advice lives on the refusal, which only a copy or an unconfirmed
    // installation receives — the live site keeps the legacy default.
    const advice = refuseAmbiguousImplicitSesDefault(flagless, "refused");
    expect(advice.ok).toBe(false);
    const text = advice.issues.join(" ");
    expect(text).toContain("USE_LOCAL_CAPTURE=true");
    expect(text).toContain("EMAIL_SERVER_HOST");

    // And the live site is untouched by that advice.
    expect(
      refuseAmbiguousImplicitSesDefault(flagless, "permitted").mode,
    ).toBe("aws-ses");
  });
});

describe("a capture with no host is not reported as a public host", () => {
  /**
   * Found reviewing this change rather than by a failing test, and it is the
   * same defect shape as the one being fixed: an absent `EMAIL_SERVER_HOST`
   * would have been classified `public-address`, so the operator would have been
   * told their host "names a host on the public internet" when it names nothing,
   * and sent to the wrong repair.
   */
  it("reports the missing setting, and only that", () => {
    const config = resolveEmailDeliveryConfigFromEnv({
      EMAIL_FROM: "club@club.test",
      USE_LOCAL_CAPTURE: "true",
      EMAIL_SERVER_PORT: "1025",
      EMAIL_SERVER_USER: "capture",
      EMAIL_SERVER_PASSWORD: "capture-only",
    });

    expect(config.ok).toBe(false);
    expect(config.captureHost).toBe("missing-host");
    expect(config.transportOptions).toBeNull();
    expect(config.issues).toContain("EMAIL_SERVER_HOST is missing");
    // The public-host refusal must NOT also fire: it would claim something about
    // a value that is not set.
    expect(config.issues.join(" ")).not.toContain("public internet");
  });

  it("does not route it to the public-host refusal outcome", () => {
    const config = resolveEmailDeliveryConfigFromEnv({
      EMAIL_FROM: "club@club.test",
      USE_LOCAL_CAPTURE: "true",
    });
    // An ordinary capture kind, exactly as before this check existed. Nothing can
    // be sent regardless: the configuration is not ok and holds no transport.
    expect(emailTransportKindOf(config)).toBe("local-capture");
    expect(emailTransportKindOf(config)).not.toBe("capture-public-host");
  });
});
