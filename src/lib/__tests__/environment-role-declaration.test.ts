import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_ROLE_DECLARED_VALUES,
  ENVIRONMENT_ROLE_ENV_VAR,
  ENVIRONMENT_ROLE_RAW_DISPLAY_MAX_LENGTH,
  readEnvironmentRoleDeclaration,
  sanitizeEnvironmentRoleRawValue,
} from "@/lib/environment-role-declaration";

/**
 * The deployment declaration parser (ENV-SAFETY 1, #3034; epic #2986).
 *
 * Everything here is about the ONE decision this module makes and the one it
 * refuses to make: it recognises exactly two words, and everything else is
 * reported as unusable rather than resolved to whichever of the two looks
 * closest. That refusal is the invariant — a parser that accepts `prod` accepts
 * `prod` typed by somebody who meant `non-production`, and INV-CONFIG-003's
 * whole point is that a typo must not be able to say "production".
 */

function read(value?: string) {
  return readEnvironmentRoleDeclaration(
    value === undefined ? {} : { [ENVIRONMENT_ROLE_ENV_VAR]: value },
  );
}

describe("the variable name is part of the contract", () => {
  it("is APP_ENVIRONMENT_ROLE", () => {
    expect(ENVIRONMENT_ROLE_ENV_VAR).toBe("APP_ENVIRONMENT_ROLE");
  });

  /*
    NEXT_PUBLIC_* is inlined into the browser bundle at BUILD time, so a public
    spelling would give a browser a second, possibly stale answer to "is this
    production?". What is keyed on that answer is whether the club's real members
    get emailed, so this is not a naming preference.
  */
  it("is not a NEXT_PUBLIC_ variable, and no public variant is read", () => {
    expect(ENVIRONMENT_ROLE_ENV_VAR.startsWith("NEXT_PUBLIC_")).toBe(false);
    expect(
      readEnvironmentRoleDeclaration({
        [`NEXT_PUBLIC_${ENVIRONMENT_ROLE_ENV_VAR}`]: "production",
      }),
    ).toEqual({ kind: "absent" });
  });

  it("accepts exactly two values and no third", () => {
    expect([...ENVIRONMENT_ROLE_DECLARED_VALUES]).toEqual([
      "production",
      "non-production",
    ]);
  });
});

describe("the two accepted declarations", () => {
  it("reads production", () => {
    expect(read("production")).toEqual({ kind: "production" });
  });

  it("reads non-production", () => {
    expect(read("non-production")).toEqual({ kind: "non-production" });
  });

  it.each([
    "PRODUCTION",
    "Production",
    "  production  ",
    "\tproduction\n",
  ])("accepts %j as production — only case and surrounding whitespace", (raw) => {
    expect(read(raw)).toEqual({ kind: "production" });
  });

  it.each(["NON-PRODUCTION", "Non-Production", " non-production "])(
    "accepts %j as non-production",
    (raw) => {
      expect(read(raw)).toEqual({ kind: "non-production" });
    },
  );
});

describe("absent", () => {
  it("is absent when the variable is unset", () => {
    expect(read()).toEqual({ kind: "absent" });
  });

  it.each(["", " ", "\t", "\n", "   \r\n  "])(
    "is absent when the variable is %j — whitespace declares nothing",
    (raw) => {
      expect(read(raw)).toEqual({ kind: "absent" });
    },
  );
});

describe("a near miss is invalid, never a guess", () => {
  /*
    Every one of these is a value somebody would plausibly type meaning
    "production" or meaning "not production", and the parser cannot tell which.
    `staging` is the one that matters most: it is the value APP_RUNTIME_ROLE
    holds on the staging stack, so an operator who confuses the two variables
    lands exactly here — and lands on UNKNOWN, which is safe, rather than on a
    guessed production.
  */
  it.each([
    "prod",
    "PROD",
    "production ready",
    "productions",
    "non_production",
    "nonproduction",
    "non production",
    "nonprod",
    "staging",
    "stage",
    "development",
    "dev",
    "test",
    "true",
    "false",
    "1",
    "0",
    "web-blue",
    "cron-leader",
  ])("refuses %j", (raw) => {
    expect(read(raw)).toEqual({ kind: "invalid", raw: raw.trim() });
  });

  it("is distinguishable from absent, so the operator surface can say which", () => {
    expect(read("prod").kind).toBe("invalid");
    expect(read().kind).toBe("absent");
    expect(read("prod").kind).not.toBe(read().kind);
  });
});

describe("the rejected value is shown back, safely", () => {
  it("keeps the operator's own text so they can see the typo", () => {
    expect(read("prodction")).toEqual({ kind: "invalid", raw: "prodction" });
  });

  /*
    A deployment variable is unbounded text. It reaches a boot log line, an
    operator's terminal (`setup:check`) and an admin page, so a newline in it
    must not be able to forge a second log line and a control byte must not be
    able to reach a rendered surface.
  */
  it("replaces control characters rather than deleting them", () => {
    expect(sanitizeEnvironmentRoleRawValue("prod\nuction")).toBe("prod?uction");
    expect(sanitizeEnvironmentRoleRawValue("prod\r\nuction")).toBe(
      "prod??uction",
    );
    expect(sanitizeEnvironmentRoleRawValue("pro\u0000d")).toBe("pro?d");
    expect(sanitizeEnvironmentRoleRawValue("pro\u001b[31md")).toBe(
      "pro?[31md",
    );
    // An ordinary space is printable and is NOT mangled: a value of
    // "non production" has to read back as the two words actually typed.
    expect(sanitizeEnvironmentRoleRawValue("non production")).toBe(
      "non production",
    );
  });

  it("strips no newline into a silently-plausible value", () => {
    // Deleting rather than replacing would render this as "production" beside a
    // message saying it was refused, which reads as an app bug.
    const declaration = read("produc\ntion");
    expect(declaration).toEqual({ kind: "invalid", raw: "produc?tion" });
  });

  it("caps the displayed value at 64 characters INCLUDING the marker", () => {
    const long = "x".repeat(500);
    const sanitized = sanitizeEnvironmentRoleRawValue(long);
    expect(sanitized.length).toBe(ENVIRONMENT_ROLE_RAW_DISPLAY_MAX_LENGTH);
    expect(sanitized.endsWith("...")).toBe(true);
    // The marker is ASCII too, so "everything this returns is printable
    // ASCII" is true of the whole string, not merely of the part before it.
    expect(/^[ -~]*$/.test(sanitized)).toBe(true);

    const declaration = read(long);
    expect(declaration.kind).toBe("invalid");
    if (declaration.kind !== "invalid") throw new Error("unreachable");
    expect(declaration.raw.length).toBeLessThanOrEqual(
      ENVIRONMENT_ROLE_RAW_DISPLAY_MAX_LENGTH,
    );
  });

  it("leaves a value exactly at the cap untouched", () => {
    const exact = "y".repeat(ENVIRONMENT_ROLE_RAW_DISPLAY_MAX_LENGTH);
    expect(sanitizeEnvironmentRoleRawValue(exact)).toBe(exact);
  });
});

describe("read live, never frozen at import", () => {
  /*
    A module-level constant would make every precedence test below vacuous: the
    test could not tell a real rule from an environment read that never happened.
    Two calls with two different environments have to disagree.
  */
  it("answers from the environment handed to it on each call", () => {
    const env: Record<string, string | undefined> = {
      [ENVIRONMENT_ROLE_ENV_VAR]: "production",
    };
    expect(readEnvironmentRoleDeclaration(env)).toEqual({ kind: "production" });
    env[ENVIRONMENT_ROLE_ENV_VAR] = "non-production";
    expect(readEnvironmentRoleDeclaration(env)).toEqual({
      kind: "non-production",
    });
    delete env[ENVIRONMENT_ROLE_ENV_VAR];
    expect(readEnvironmentRoleDeclaration(env)).toEqual({ kind: "absent" });
  });

  it("defaults to process.env", () => {
    const before = process.env[ENVIRONMENT_ROLE_ENV_VAR];
    try {
      process.env[ENVIRONMENT_ROLE_ENV_VAR] = "non-production";
      expect(readEnvironmentRoleDeclaration()).toEqual({
        kind: "non-production",
      });
    } finally {
      if (before === undefined) delete process.env[ENVIRONMENT_ROLE_ENV_VAR];
      else process.env[ENVIRONMENT_ROLE_ENV_VAR] = before;
    }
  });
});
