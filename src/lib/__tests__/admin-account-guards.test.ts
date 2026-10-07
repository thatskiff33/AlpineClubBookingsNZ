// Unit tests for issue #1604: the last-admin and privileged-target guards.
// These exercise the pure count/predicate helpers against a stub db so the
// query shape (the Full-Admin definition) and the end-state arithmetic are
// locked independently of any single route.
import { describe, it, expect, vi } from "vitest";
import {
  ACTIVE_FULL_ADMIN_WHERE,
  AdminAccountGuardError,
  actorIsFullAdmin,
  countActiveFullAdmins,
  wouldRemoveAllFullAdmins,
  wouldRemoveLastFullAdmin,
} from "@/lib/admin-account-guards";
import { memberHoldsPrivilegedRole } from "@/lib/access-roles";

function stubDb(counts: number[]) {
  const count = vi.fn();
  for (const value of counts) count.mockResolvedValueOnce(value);
  return { db: { member: { count } } as never, count };
}

describe("ACTIVE_FULL_ADMIN_WHERE — the Full-Admin definition (issue #1604)", () => {
  it("counts on the ADMIN access-role row plus active + login, never the legacy role column", () => {
    expect(ACTIVE_FULL_ADMIN_WHERE).toEqual({
      active: true,
      canLogin: true,
      accessRoles: { some: { role: "ADMIN" } },
    });
    // Locking this pins the count to what requireAdmin actually grants on: a
    // legacy `role:"ADMIN"` with no ADMIN access-role row confers no admin
    // access at runtime, so it must not be counted as a remaining admin.
    expect(ACTIVE_FULL_ADMIN_WHERE).not.toHaveProperty("role");
  });
});

describe("countActiveFullAdmins", () => {
  it("queries active, login-enabled ADMIN-role members", async () => {
    const { db, count } = stubDb([3]);
    await expect(countActiveFullAdmins(db)).resolves.toBe(3);
    expect(count).toHaveBeenCalledWith({ where: ACTIVE_FULL_ADMIN_WHERE });
  });

  it("excludes the given member ids", async () => {
    const { db, count } = stubDb([1]);
    await countActiveFullAdmins(db, { excludeMemberIds: ["a", "b"] });
    expect(count).toHaveBeenCalledWith({
      where: { ...ACTIVE_FULL_ADMIN_WHERE, id: { notIn: ["a", "b"] } },
    });
  });
});

describe("wouldRemoveLastFullAdmin", () => {
  it("is false when the target is not an active Full Admin", async () => {
    const { db, count } = stubDb([0]);
    await expect(wouldRemoveLastFullAdmin(db, "m1")).resolves.toBe(false);
    expect(count).toHaveBeenCalledTimes(1); // short-circuits, no second count
  });

  it("is true when the target is the only active Full Admin", async () => {
    const { db } = stubDb([1, 0]);
    await expect(wouldRemoveLastFullAdmin(db, "m1")).resolves.toBe(true);
  });

  it("is false when another active Full Admin remains (second-to-last)", async () => {
    const { db } = stubDb([1, 1]);
    await expect(wouldRemoveLastFullAdmin(db, "m1")).resolves.toBe(false);
  });
});

describe("wouldRemoveAllFullAdmins (bulk end-state)", () => {
  it("is false when there are no active Full Admins to begin with", async () => {
    const { db, count } = stubDb([0]);
    await expect(wouldRemoveAllFullAdmins(db, ["a"])).resolves.toBe(false);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("is true when the set removes every remaining Full Admin", async () => {
    const { db } = stubDb([2, 0]);
    await expect(wouldRemoveAllFullAdmins(db, ["a", "b"])).resolves.toBe(true);
  });

  it("is false when at least one Full Admin survives the set", async () => {
    const { db } = stubDb([3, 1]);
    await expect(wouldRemoveAllFullAdmins(db, ["a", "b"])).resolves.toBe(false);
  });
});

describe("actorIsFullAdmin", () => {
  it("is true when the actor holds the ADMIN access role", async () => {
    const { db, count } = stubDb([1]);
    await expect(actorIsFullAdmin(db, "actor")).resolves.toBe(true);
    expect(count).toHaveBeenCalledWith({
      where: { id: "actor", ...ACTIVE_FULL_ADMIN_WHERE },
    });
  });

  it("counts only an active, login-enabled actor, like the Full Admin definition (#3603)", async () => {
    const { db, count } = stubDb([0]);
    await actorIsFullAdmin(db, "actor");
    // Spelled out, not spread, so dropping either flag from the query fails
    // here even if ACTIVE_FULL_ADMIN_WHERE itself were edited to match.
    expect(count).toHaveBeenCalledWith({
      where: {
        id: "actor",
        active: true,
        canLogin: true,
        accessRoles: { some: { role: "ADMIN" } },
      },
    });
  });

  it("is false when the actor holds no ADMIN row", async () => {
    const { db } = stubDb([0]);
    await expect(actorIsFullAdmin(db, "actor")).resolves.toBe(false);
  });
});

describe("AdminAccountGuardError", () => {
  it("defaults to a 409 conflict status", () => {
    const err = new AdminAccountGuardError("nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(409);
  });
});

describe("memberHoldsPrivilegedRole (canLogin-blind privileged-target predicate)", () => {
  it("is false for a plain user", () => {
    expect(
      memberHoldsPrivilegedRole({
        accessRoles: [{ role: "USER" }],
        role: "USER",
        financeAccessLevel: "NONE",
      }),
    ).toBe(false);
  });

  it("is false for an organisation account", () => {
    expect(
      memberHoldsPrivilegedRole({
        accessRoles: [{ role: "ORG" }],
        role: "SCHOOL",
        financeAccessLevel: "NONE",
      }),
    ).toBe(false);
  });

  it("is true for a live admin", () => {
    expect(
      memberHoldsPrivilegedRole({
        accessRoles: [{ role: "ADMIN" }],
        role: "ADMIN",
        financeAccessLevel: "NONE",
      }),
    ).toBe(true);
  });

  it("is true for a cancelled ex-admin whose canLogin is already false (dormant legacy role)", () => {
    // Cancellation/archive clear canLogin (and may drop the access-role rows)
    // but leave the stored legacy role, which is exactly what the guard must
    // still protect from a scoped admin.
    expect(
      memberHoldsPrivilegedRole({
        accessRoles: [],
        role: "ADMIN",
        financeAccessLevel: "NONE",
      }),
    ).toBe(true);
  });

  it("is true for a definition-backed custom role", () => {
    expect(
      memberHoldsPrivilegedRole({
        accessRoles: [{ role: null, roleDefinitionId: "def-treasurer" }],
        role: "USER",
        financeAccessLevel: "NONE",
      }),
    ).toBe(true);
  });
});
