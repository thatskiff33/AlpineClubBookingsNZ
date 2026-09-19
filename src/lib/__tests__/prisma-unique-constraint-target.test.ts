/**
 * What a P2002 really looks like under Prisma 7 + `@prisma/adapter-pg` (#2412),
 * and the two things that read it: the join-code collision retry and the
 * login-email backstop.
 *
 * The collision fixtures are live captures; a few extra shapes there are marked
 * SYNTHETIC because they probe the parser rather than record the driver. See
 * `helpers/p2002-fixtures.ts` for how and when the captures were taken, and for
 * the finding they pin down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import {
  describeUniqueConstraintTarget,
  isPrismaUniqueConstraintError,
} from "@/lib/prisma-errors";
import { isLoginEmailUniqueConflict } from "@/lib/member-email";
import {
  compositeCollisionError,
  contradictoryAdapterAndMessageError,
  emailChangeTokenIndexNameCollisionError,
  googleSubCollisionError,
  joinCodeCollisionError,
  loginEmailCollisionError,
  organiserBookingCollisionError,
  unidentifiableUniqueCollisionError,
} from "@/lib/__tests__/helpers";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: vi.fn() },
    groupBooking: { create: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { createGroupBooking } from "@/lib/group-booking";

describe("adapter-pg P2002 shape (captured live, PostgreSQL 16 + Prisma 7.9.0)", () => {
  it("carries the colliding columns in the adapter detail and nothing in meta.target", () => {
    // Pins the shape of the CAPTURES, not Prisma's behaviour: these are the
    // bytes that came back on 1 Aug 2026, kept legible so an edit that "tidies"
    // a fixture into a shape the driver never emits is visible here.
    for (const build of [
      joinCodeCollisionError,
      organiserBookingCollisionError,
      loginEmailCollisionError,
      googleSubCollisionError,
    ]) {
      const meta = build().meta as {
        target?: unknown;
        driverAdapterError?: {
          cause?: { constraint?: { fields?: unknown }; originalCode?: unknown };
        };
      };
      expect(meta).not.toHaveProperty("target");
      expect(meta.driverAdapterError?.cause?.originalCode).toBe("23505");
      expect(meta.driverAdapterError?.cause?.constraint?.fields).toEqual([
        expect.any(String),
      ]);
    }
  });

  it("answers from the adapter detail, not the rendered message", () => {
    // The measured signal wins: this fixture's message names googleSub while
    // its `constraint.fields` names email, so dropping the adapter branch and
    // falling through to the message flips the answer.
    expect(
      describeUniqueConstraintTarget(contradictoryAdapterAndMessageError()),
    ).toBe("email");
    expect(
      isLoginEmailUniqueConflict(contradictoryAdapterAndMessageError()),
    ).toBe(true);
  });

  it("names the colliding column for a schema-level @unique, quoting and all", () => {
    expect(describeUniqueConstraintTarget(joinCodeCollisionError())).toBe(
      "joincode",
    );
    expect(
      describeUniqueConstraintTarget(organiserBookingCollisionError()),
    ).toBe("organiserbookingid");
  });

  it("names the colliding column for a raw partial index too", () => {
    // Member_email_login_unique is hand-written SQL, not a schema `@unique`,
    // and it still reports its COLUMN rather than its index name.
    expect(describeUniqueConstraintTarget(loginEmailCollisionError())).toBe(
      "email",
    );
  });
});

describe("describeUniqueConstraintTarget fallbacks", () => {
  it("prefers meta.target when a non-adapter stack populates it", () => {
    // The message says the opposite, so this fails if the branch is dropped or
    // loses its precedence.
    const error = Object.assign(
      new Error("Unique constraint failed on the fields: (`googleSub`)"),
      { code: "P2002", meta: { target: ["email"] } },
    );
    expect(describeUniqueConstraintTarget(error)).toBe("email");
  });

  it("accepts meta.target as a bare constraint-name string", () => {
    const error = Object.assign(new Error("boom"), {
      code: "P2002",
      meta: { target: "Member_email_login_unique" },
    });
    expect(describeUniqueConstraintTarget(error)).toBe(
      "member_email_login_unique",
    );
  });

  it("joins a composite field list", () => {
    const error = Object.assign(new Error("boom"), {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: { constraint: { fields: ['"memberId"', '"seasonYear"'] } },
        },
      },
    });
    expect(describeUniqueConstraintTarget(error)).toBe("memberid seasonyear");
  });

  it("describes a composite constraint identically whichever shape carried it", () => {
    // The adapter hands over an array, the message a comma-separated list. A
    // caller comparing names must not get a different answer depending on
    // whether Postgres sent the `Key (…)` detail.
    expect(
      describeUniqueConstraintTarget(compositeCollisionError("adapter-detail")),
    ).toBe(
      describeUniqueConstraintTarget(compositeCollisionError("message-only")),
    );
    expect(
      describeUniqueConstraintTarget(compositeCollisionError("message-only")),
    ).toBe("memberid seasonyear");
  });

  it("reads a constraint index name when the adapter reports one", () => {
    const error = Object.assign(new Error("boom"), {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: { constraint: { index: "Member_email_login_unique" } },
        },
      },
    });
    expect(describeUniqueConstraintTarget(error)).toBe(
      "member_email_login_unique",
    );
  });

  it("falls back to the message when Postgres withholds the Key (…) detail", () => {
    // With no `detail` on the driver error, adapter-pg leaves `constraint`
    // undefined and only the rendered sentence is left. Wrapped in the real
    // invocation preamble, so a match anchored at the start would miss it.
    const error = Object.assign(
      new Error(
        [
          "",
          "Invalid `prisma.member.update()` invocation in",
          "/app/src/lib/admin-member-detail-service.ts:1278:44",
          "",
          '→ 1278   where: { id: "m1" },',
          "Unique constraint failed on the fields: (`email`)",
        ].join("\n"),
      ),
      { code: "P2002", meta: { driverAdapterError: { cause: {} } } },
    );
    expect(describeUniqueConstraintTarget(error)).toBe("email");
  });

  it("is not hijacked by member data rendered into the invocation excerpt", () => {
    // The preamble echoes the CALL ARGUMENTS, so anything an admin typed can
    // appear above Prisma's own sentence. Matching a bare `fields: (…)` would
    // read this member's comments field and blame googleSub for what the
    // database says is the login-email clash.
    const error = Object.assign(
      new Error(
        [
          "",
          "Invalid `prisma.member.create()` invocation in",
          "/app/src/lib/admin-members-service.ts:1400:33",
          "",
          '→ 1400   data: { comments: "fields: (googleSub)" },',
          "Unique constraint failed on the fields: (`email`)",
        ].join("\n"),
      ),
      { code: "P2002", meta: { driverAdapterError: { cause: {} } } },
    );
    expect(describeUniqueConstraintTarget(error)).toBe("email");
    expect(isLoginEmailUniqueConflict(error)).toBe(true);
  });

  it("is not hijacked by a `constraint:` name in the invocation excerpt either", () => {
    const error = Object.assign(
      new Error(
        [
          "",
          "Invalid `prisma.member.create()` invocation in",
          '→ 1400   data: { comments: "constraint: `Member_googleSub_key`" },',
          "Unique constraint failed on the constraint: `Member_email_login_unique`",
        ].join("\n"),
      ),
      { code: "P2002" },
    );
    expect(describeUniqueConstraintTarget(error)).toBe(
      "member_email_login_unique",
    );
  });

  it("reads a `constraint:` index name from the message", () => {
    const error = Object.assign(
      new Error(
        "Unique constraint failed on the constraint: `Member_email_login_unique`",
      ),
      { code: "P2002" },
    );
    expect(describeUniqueConstraintTarget(error)).toBe(
      "member_email_login_unique",
    );
  });

  it("returns null when the error names nothing identifiable", () => {
    expect(
      describeUniqueConstraintTarget(unidentifiableUniqueCollisionError()),
    ).toBeNull();
    expect(describeUniqueConstraintTarget(null)).toBeNull();
    expect(describeUniqueConstraintTarget("not an error")).toBeNull();
  });
});

describe("isLoginEmailUniqueConflict against the live shapes", () => {
  it("recognises the raw partial index the login invariant rests on", () => {
    expect(isLoginEmailUniqueConflict(loginEmailCollisionError())).toBe(true);
    expect(isLoginEmailUniqueConflict(loginEmailCollisionError("update"))).toBe(
      true,
    );
  });

  it("does not blame the email for another column", () => {
    expect(isLoginEmailUniqueConflict(googleSubCollisionError())).toBe(false);
  });

  it("does not read an index NAME that merely contains 'email' as the clash", () => {
    // The target can be an index name rather than a column list, and a Prisma
    // index name carries its model prefix: this one normalises to a single
    // word that CONTAINS "email". Matching whole words is what keeps a token
    // hash from telling a member their new address is taken (#2455).
    const error = emailChangeTokenIndexNameCollisionError();
    expect(describeUniqueConstraintTarget(error)).toBe(
      "emailchangetoken_tokenhash_key",
    );
    expect(isLoginEmailUniqueConflict(error)).toBe(false);
  });

  it("recognises the login index by name when the column list is gone", () => {
    // Same shape, the constraint the invariant actually rests on: still yes.
    const error = Object.assign(
      new Error(
        "Unique constraint failed on the constraint: `Member_email_login_unique`",
      ),
      { code: "P2002" },
    );
    expect(isLoginEmailUniqueConflict(error)).toBe(true);
  });

  it("still owns a P2002 that names nothing", () => {
    expect(
      isLoginEmailUniqueConflict(unidentifiableUniqueCollisionError()),
    ).toBe(true);
  });

  it("disowns the unnamed P2002 for a write that cannot claim a login email", () => {
    // `Member_email_login_unique` is `WHERE "canLogin" = true`, so a non-login
    // write cannot have hit it, whatever else collided.
    expect(
      isLoginEmailUniqueConflict(unidentifiableUniqueCollisionError(), {
        canClaimLoginEmail: false,
      }),
    ).toBe(false);
    // A NAMED email clash is still the email clash, flag or no flag.
    expect(
      isLoginEmailUniqueConflict(loginEmailCollisionError(), {
        canClaimLoginEmail: false,
      }),
    ).toBe(true);
  });

  it("ignores errors that are not P2002 at all", () => {
    expect(isLoginEmailUniqueConflict(new Error("email"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The join-code retry the shape question actually broke
// ---------------------------------------------------------------------------

describe("createGroupBooking join-code collision retry", () => {
  const organiserBooking = {
    id: "b1",
    memberId: "m1",
    status: "CONFIRMED",
    deletedAt: null,
    parentBookingId: null,
    groupBookingAsOrganiser: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      organiserBooking as never,
    );
  });

  const input = {
    organiserBookingId: "b1",
    paymentMode: "EACH_PAYS_OWN" as const,
  };

  const attemptedCodes = () =>
    vi
      .mocked(prisma.groupBooking.create)
      .mock.calls.map(
        (call) => (call[0] as unknown as { data: { joinCode: string } }).data.joinCode,
      );

  it("regenerates the code and retries on a real joinCode collision", async () => {
    vi.mocked(prisma.groupBooking.create)
      .mockRejectedValueOnce(joinCodeCollisionError())
      .mockRejectedValueOnce(joinCodeCollisionError())
      .mockResolvedValueOnce({ id: "g1", joinCode: "ABCDEFGH" } as never);

    await expect(createGroupBooking(input, "m1")).resolves.toMatchObject({
      id: "g1",
    });
    expect(prisma.groupBooking.create).toHaveBeenCalledTimes(3);
    // Each attempt used a freshly generated code, not the rejected one.
    expect(new Set(attemptedCodes()).size).toBe(3);
  });

  it("reports code exhaustion, not 'already has a group', after the budget", async () => {
    vi.mocked(prisma.groupBooking.create).mockRejectedValue(
      joinCodeCollisionError(),
    );

    await expect(createGroupBooking(input, "m1")).rejects.toMatchObject({
      status: 500,
      message: "Could not generate a unique join code, please try again",
    });
    expect(prisma.groupBooking.create).toHaveBeenCalledTimes(5);
  });

  it("does not retry an organiserBookingId collision — that is a real conflict", async () => {
    vi.mocked(prisma.groupBooking.create).mockRejectedValue(
      organiserBookingCollisionError(),
    );

    await expect(createGroupBooking(input, "m1")).rejects.toMatchObject({
      status: 409,
      message: "This booking already has a group",
    });
    expect(prisma.groupBooking.create).toHaveBeenCalledTimes(1);
  });

  it("does not retry a P2002 that names nothing identifiable", async () => {
    vi.mocked(prisma.groupBooking.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("boom", {
        code: "P2002",
        clientVersion: "7.9.0",
      }),
    );

    await expect(createGroupBooking(input, "m1")).rejects.toMatchObject({
      status: 409,
      message: "This booking already has a group",
    });
    expect(prisma.groupBooking.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE ONE P2002 PREDICATE (#2723). There used to be three: this one, a copy in
 * `config-self-heal.ts` that also tested `instanceof
 * Prisma.PrismaClientKnownRequestError`, and a third written into the credential
 * claim module with only the duck-typed half. Three copies of one rule is three
 * places to edit when unique violations start arriving under a second code, and
 * the copy nobody remembers is the one that then rethrows instead of yielding to
 * the winner of a race. They are one function now.
 *
 * The first case is what the deleted `instanceof` branch used to cover, and it
 * is why folding that copy in loses nothing: a real
 * `PrismaClientKnownRequestError` carries `code` as its own property, so the
 * structural check answers for the class too. It is asserted against the real
 * class rather than a look-alike, because that is the whole question.
 */
describe("isPrismaUniqueConstraintError — the one home (#2723)", () => {
  it("detects a real PrismaClientKnownRequestError, class and all", () => {
    expect(
      isPrismaUniqueConstraintError(
        new Prisma.PrismaClientKnownRequestError("duplicate key", {
          code: "P2002",
          clientVersion: "7.9.0",
        }),
      ),
    ).toBe(true);
  });

  it("detects a structural P2002, plain object or Error", () => {
    expect(isPrismaUniqueConstraintError({ code: "P2002" })).toBe(true);
    expect(
      isPrismaUniqueConstraintError(
        Object.assign(new Error("dup"), { code: "P2002" }),
      ),
    ).toBe(true);
  });

  it("rejects everything else, including a neighbouring Prisma code", () => {
    expect(
      isPrismaUniqueConstraintError(
        new Prisma.PrismaClientKnownRequestError("fk", {
          code: "P2003",
          clientVersion: "7.9.0",
        }),
      ),
    ).toBe(false);
    expect(isPrismaUniqueConstraintError(new Error("boom"))).toBe(false);
    expect(isPrismaUniqueConstraintError({ code: "P2003" })).toBe(false);
    expect(isPrismaUniqueConstraintError(null)).toBe(false);
    expect(isPrismaUniqueConstraintError(undefined)).toBe(false);
  });
});
