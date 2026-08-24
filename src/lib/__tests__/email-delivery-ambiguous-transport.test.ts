import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ambiguous-configuration hole (ENV-SAFETY 2, #3035; epic #2986;
 * INV-CONFIG-004).
 *
 * With NEITHER `USE_AWS_SES` nor `USE_SMTP_RELAY` set, the delivery parser has
 * always resolved LIVE AWS SES with only a warning. On the club's own site that
 * is a deliberate backward-compatibility default and this issue's acceptance
 * criteria require it to stay. Anywhere else it means a copy opening a connection
 * to the club's real mail provider with the club's real credentials.
 *
 * WHERE IT ACTUALLY BITES, because a test that overclaims is worse than none.
 * On the SEND path the delivery policy has already suppressed or blocked before
 * any transport is asked for, so this rule is defence in depth there. On the
 * VERIFY path — the health check and the setup wizard's provider test — it is the
 * operative rule, because `transporter.verify()` really does connect.
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
  refuseAmbiguousImplicitSesDefault,
  resolveEmailDeliveryConfigFromEnv,
} from "@/lib/email-delivery";
import { verifyEmailTransport } from "@/lib/email/internal";
import {
  declareEnvironmentRole,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";

const CREDENTIALLED_ENV = {
  EMAIL_FROM: "club@club.test",
  AWS_SES_ACCESS_KEY_ID: "key",
  AWS_SES_SECRET_ACCESS_KEY: "secret",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.environmentSafetyFindUnique.mockResolvedValue(null);
  mocks.verify.mockResolvedValue(true);
  mocks.createTransport.mockReturnValue({ verify: mocks.verify });
});

describe("resolveEmailDeliveryConfigFromEnv reports HOW the mode was chosen", () => {
  it("marks the flagless legacy fallback, so the rule is not keyed on a warning string", () => {
    const config = resolveEmailDeliveryConfigFromEnv(CREDENTIALLED_ENV);
    expect(config.mode).toBe("aws-ses");
    expect(config.modeSource).toBe("implicit-legacy-default");
  });

  /**
   * EXACTLY ONE FLAG, and nothing pinned that number before #3035's review.
   *
   * The only file exercising this parser covered one flag set and zero flags set,
   * so `selectedModes === 1` was undiscriminated — changing it to `>= 1` failed
   * nothing. Its real-world form is not theoretical: an operator who adds
   * `USE_LOCAL_CAPTURE=true` to a copy WITHOUT clearing the relay flag it
   * inherited would, under `>= 1`, resolve `local-capture` — which the delivery
   * policy treats as an allow on a copy — while `EMAIL_SERVER_*` still point at a
   * real relay. That copy then transmits through a real provider to real members,
   * with the boundary's blessing.
   *
   * So every multi-flag combination resolves `invalid` and names the rule.
   */
  it("refuses any combination of two or three provider flags", () => {
    const RELAY = {
      EMAIL_FROM: "club@club.test",
      EMAIL_SERVER_HOST: "relay.club.test",
      EMAIL_SERVER_PORT: "587",
      EMAIL_SERVER_USER: "u",
      EMAIL_SERVER_PASSWORD: "p",
    };
    const combinations: Record<string, string>[] = [
      { USE_AWS_SES: "true", USE_SMTP_RELAY: "true" },
      { USE_AWS_SES: "true", USE_LOCAL_CAPTURE: "true" },
      { USE_SMTP_RELAY: "true", USE_LOCAL_CAPTURE: "true" },
      { USE_AWS_SES: "true", USE_SMTP_RELAY: "true", USE_LOCAL_CAPTURE: "true" },
    ];
    for (const flags of combinations) {
      const config = resolveEmailDeliveryConfigFromEnv({
        ...CREDENTIALLED_ENV,
        ...RELAY,
        ...flags,
      });
      const named = Object.keys(flags).join(" + ");
      expect(config.mode, `${named} must not resolve a usable mode`).toBe(
        "invalid",
      );
      expect(config.ok, `${named} must not be usable`).toBe(false);
      expect(config.transportOptions, `${named} must open nothing`).toBeNull();
      expect(config.modeSource, `${named} chose no mode`).toBe("unresolved");
      expect(
        config.issues.join(" "),
        `${named} must say only one flag may be true`,
      ).toContain("Only one of");
    }
  });

  it("refuses a flag that is neither true nor false, and fails CLOSED when it does", () => {
    /*
      A TYPO'D FLAG IS TREATED AS UNSET, AND THE INTERACTION IS WORTH PINNING
      because it is not the obvious one. `parseBooleanFlag` records an issue and
      returns `undefined` for anything that is not `true`/`false`, so
      `USE_AWS_SES=yes` leaves all three flags `undefined` — which is the
      implicit-legacy-default branch, and `mode` therefore comes back `aws-ses`
      rather than `invalid`.

      That reads alarming and is not, and the reason is the recorded issue:
      `ok` is false, so `getEmailTransporter` throws "Email delivery is not
      configured" before building anything, on the live site as much as on a copy.
      The typo cannot become a silent send. Asserted here so a later "tidy-up"
      that drops the issue — or that returns `ok: true` alongside a mode chosen by
      fallback — is caught, because THAT would be a live SES connection from a
      misconfigured installation.
    */
    const typo = resolveEmailDeliveryConfigFromEnv({
      ...CREDENTIALLED_ENV,
      USE_AWS_SES: "yes",
    });
    expect(typo.issues.join(" ")).toContain("USE_AWS_SES must be true or false");
    /*
      The load-bearing assertion is `ok`, and ONLY `ok`. Note carefully that
      `transportOptions` is NOT null here — the AWS SES branch builds them from
      the credentials that happen to be present — so everything rests on both
      consumers testing `!config.ok` BEFORE `!config.transportOptions`. They do
      (`getEmailTransporter` and `verifyEmailTransport`), and the behavioural half
      of this claim is the `verifyEmailTransport` case below, which proves no
      transport is constructed at all.
    */
    expect(typo.ok).toBe(false);
    expect(typo.transportOptions).not.toBeNull();
    // And it is the FALLBACK that chose the mode, not the operator, so the
    // ambiguous-default refusal applies to it outside confirmed production.
    expect(typo.modeSource).toBe("implicit-legacy-default");
    expect(refuseAmbiguousImplicitSesDefault(typo, "refused").mode).toBe(
      "invalid",
    );

    // A typo BESIDE an explicit `false` is plainly invalid: not every flag is
    // undefined, so the fallback branch is not reached at all.
    const beside = resolveEmailDeliveryConfigFromEnv({
      ...CREDENTIALLED_ENV,
      USE_AWS_SES: "false",
      USE_LOCAL_CAPTURE: "ture",
    });
    expect(beside.mode).toBe("invalid");
    expect(beside.ok).toBe(false);

    // And the accepted spellings really are case-insensitive, so a guard written
    // against lower case only would disagree with this parser — which is why the
    // compose census normalises case too.
    const shouty = resolveEmailDeliveryConfigFromEnv({
      ...CREDENTIALLED_ENV,
      USE_AWS_SES: "TRUE",
    });
    expect(shouty.mode).toBe("aws-ses");
    expect(shouty.modeSource).toBe("explicit-flag");
  });

  it("resolves the capture mode from its own flag, and labels it distinctly", () => {
    // The third mode's own row in the table, which nothing covered: it reads the
    // same four EMAIL_SERVER_* settings as the relay and differs only in the
    // declaration and the label.
    const config = resolveEmailDeliveryConfigFromEnv({
      EMAIL_FROM: "club@club.test",
      USE_LOCAL_CAPTURE: "true",
      EMAIL_SERVER_HOST: "mailpit",
      EMAIL_SERVER_PORT: "1025",
      EMAIL_SERVER_USER: "u",
      EMAIL_SERVER_PASSWORD: "p",
    });
    expect(config.mode).toBe("local-capture");
    expect(config.modeLabel).toBe("Local capture mailbox");
    expect(config.modeSource).toBe("explicit-flag");
    expect(config.ok).toBe(true);
  });

  it("marks an explicit flag as explicit", () => {
    expect(
      resolveEmailDeliveryConfigFromEnv({
        ...CREDENTIALLED_ENV,
        USE_AWS_SES: "true",
      }).modeSource,
    ).toBe("explicit-flag");
    expect(
      resolveEmailDeliveryConfigFromEnv({
        EMAIL_FROM: "club@club.test",
        USE_SMTP_RELAY: "true",
        EMAIL_SERVER_HOST: "mailpit",
        EMAIL_SERVER_PORT: "1025",
        EMAIL_SERVER_USER: "u",
        EMAIL_SERVER_PASSWORD: "p",
      }).modeSource,
    ).toBe("explicit-flag");
  });
});

describe("refuseAmbiguousImplicitSesDefault", () => {
  const flagless = () => resolveEmailDeliveryConfigFromEnv(CREDENTIALLED_ENV);

  it("leaves confirmed production exactly as it was", () => {
    const config = flagless();
    expect(refuseAmbiguousImplicitSesDefault(config, "permitted")).toBe(config);
  });

  it("refuses the fallback everywhere else, and gives advice that WORKS", () => {
    /*
      THIS STRING IS THE ONLY THING AN OPERATOR SEES ON THE VERIFY PATH — the
      health check and the setup wizard's SMTP test both surface it verbatim — and
      before #3035's review it advised the configuration that does not work. It
      said "a copy usually wants USE_SMTP_RELAY pointed at a local capture
      mailbox"; follow that on a copy and the transport resolves `live-provider`,
      so the delivery policy suppresses every send. The operator has done exactly
      as instructed and nothing goes anywhere. It also named two of the three
      flags, and contradicted `describeDeliveryDecision` twenty lines away in the
      same feature.

      Pinned here because no test pinned it at all, which is how it shipped wrong.
    */
    const refused = refuseAmbiguousImplicitSesDefault(flagless(), "refused");
    expect(refused.ok).toBe(false);
    expect(refused.transportOptions).toBeNull();

    const advice = refused.issues[0];
    // All THREE flags, so the operator is not told about two thirds of the
    // choice.
    for (const flag of ["USE_AWS_SES", "USE_SMTP_RELAY", "USE_LOCAL_CAPTURE"]) {
      expect(advice, `the refusal must name ${flag}`).toContain(flag);
    }
    // And it must not repeat the refuted advice: a relay is not the answer for a
    // copy that wants its mail captured.
    expect(advice).not.toContain("usually wants USE_SMTP_RELAY");
    expect(advice).toContain("USE_LOCAL_CAPTURE=true");
    // The reason that advice was wrong, said out loud, so the next reader does
    // not helpfully simplify it back.
    expect(advice.toLowerCase()).toContain("live provider");
    // It never echoes a credential back at the operator, even though it holds
    // one at this point.
    expect(refused.issues.join(" ")).not.toContain("secret");
  });

  it("does not touch an explicitly-flagged configuration, whatever the role", () => {
    /*
      A copy pointed at a local capture mailbox is a legitimate, useful setup and
      must keep working — this rule is about the SILENT fallback to the club's live
      provider, not about non-production sending at all.
    */
    const explicit = resolveEmailDeliveryConfigFromEnv({
      EMAIL_FROM: "club@club.test",
      USE_SMTP_RELAY: "true",
      EMAIL_SERVER_HOST: "mailpit",
      EMAIL_SERVER_PORT: "1025",
      EMAIL_SERVER_USER: "u",
      EMAIL_SERVER_PASSWORD: "p",
    });
    expect(refuseAmbiguousImplicitSesDefault(explicit, "refused")).toBe(explicit);
    expect(explicit.ok).toBe(true);
  });
});

describe("verifyEmailTransport", () => {
  beforeEach(() => {
    vi.stubEnv("EMAIL_FROM", "club@club.test");
    vi.stubEnv("AWS_SES_ACCESS_KEY_ID", "key");
    vi.stubEnv("AWS_SES_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("USE_AWS_SES", "");
    vi.stubEnv("USE_SMTP_RELAY", "");
  });

  it("verifies on the club's live site, where the legacy default still stands", async () => {
    declareEnvironmentRole("production");
    await expect(verifyEmailTransport()).resolves.toEqual({
      modeLabel: "AWS SES",
    });
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });

  it("opens no connection at all on a declared copy with no provider flag set", async () => {
    declareEnvironmentRole("non-production");
    await expect(verifyEmailTransport()).rejects.toThrow(
      /Email delivery config invalid/,
    );
    // The point of the whole rule: no transport was constructed, so no
    // credential was presented to the club's live provider.
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("opens no connection when nobody has said what this installation is", async () => {
    undeclareEnvironmentRole();
    await expect(verifyEmailTransport()).rejects.toThrow(
      /Email delivery config invalid/,
    );
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it("opens no connection for a MISTYPED flag, even on the club's live site", async () => {
    /*
      The behavioural half of the typo case above. A mistyped flag leaves every
      flag `undefined`, so the mode is chosen by the legacy fallback and comes back
      `aws-ses` with real credentials attached — and only the recorded issue
      (`ok: false`) stands between that and a live SES connection from an
      installation nobody configured properly. Confirmed production is the case
      that matters, because it is the one the ambiguous-default refusal does NOT
      cover.
    */
    declareEnvironmentRole("production");
    vi.stubEnv("USE_AWS_SES", "yes");

    await expect(verifyEmailTransport()).rejects.toThrow(
      /Email delivery config invalid/,
    );
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("hands back no transport, so a diagnostic cannot become a sender", async () => {
    /*
      A structural property, not a behavioural one: the return type is
      `{ modeLabel }`. If a future edit returned the `Transporter` instead, the
      health check and the provider-test route would silently gain the ability to
      send from an installation the delivery policy has refused.
    */
    declareEnvironmentRole("production");
    const result = await verifyEmailTransport();
    expect(Object.keys(result)).toEqual(["modeLabel"]);
    expect(result).not.toHaveProperty("transporter");
  });

  it("verifies a copy pointed at an explicit SMTP RELAY, which is still a live provider", async () => {
    /*
      RENAMED, because the old title said "a capture mailbox explicitly" while the
      body set `USE_SMTP_RELAY` (#3035 review). Those are different declarations
      with opposite consequences — a relay counts as a live provider however it is
      configured — and a test whose name describes the other case is worse than no
      test, because the next reader trusts the name. The capture case is the one
      below.
    */
    declareEnvironmentRole("non-production");
    vi.stubEnv("USE_SMTP_RELAY", "true");
    vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
    vi.stubEnv("EMAIL_SERVER_PORT", "1025");
    vi.stubEnv("EMAIL_SERVER_USER", "u");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "p");

    await expect(verifyEmailTransport()).resolves.toEqual({
      modeLabel: "SMTP Relay",
    });
  });

  it("verifies a copy pointed at a DECLARED capture mailbox, and labels it as one", async () => {
    /*
      There was no `verifyEmailTransport` test under capture mode at all, so
      `modeLabel: "Local capture mailbox"` — the label the health check and the
      setup wizard show an operator — was asserted nowhere. That label is how a
      person confirms their capture declaration took effect at all.
    */
    declareEnvironmentRole("non-production");
    vi.stubEnv("USE_LOCAL_CAPTURE", "true");
    vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
    vi.stubEnv("EMAIL_SERVER_PORT", "1025");
    vi.stubEnv("EMAIL_SERVER_USER", "u");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "p");

    await expect(verifyEmailTransport()).resolves.toEqual({
      modeLabel: "Local capture mailbox",
    });
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });
});
