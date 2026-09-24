import { describe, expect, it, vi } from "vitest";
import { honourSelect, projectInclude, projectSelect } from "./prisma-mocks";

/**
 * The select-honouring mock (#3603) is what makes a guard suite fail when the
 * guard stops selecting a field, so its own shape rules are pinned here.
 */

const MEMBER = {
  id: "m-1",
  canLogin: false,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  accessRoles: [
    {
      role: "ADMIN",
      roleDefinitionId: "def-1",
      roleDefinition: { id: "def-1", bookingsLevel: "EDIT" },
    },
  ],
  lodge: { id: "l-1", name: "Lodge", owner: { id: "o-1" } },
};

describe("projectSelect", () => {
  it("drops a field the query did not select", () => {
    expect(projectSelect(MEMBER, { id: true })).toEqual({ id: "m-1" });
  });

  it("keeps a Date scalar whole", () => {
    expect(projectSelect(MEMBER, { createdAt: true })).toEqual({
      createdAt: MEMBER.createdAt,
    });
  });

  it("projects a relation through its nested select", () => {
    expect(
      projectSelect(MEMBER, { accessRoles: { select: { role: true } } }),
    ).toEqual({ accessRoles: [{ role: "ADMIN" }] });
  });

  it("keeps only the scalars of a relation selected with true", () => {
    expect(projectSelect(MEMBER, { accessRoles: true, lodge: true })).toEqual({
      accessRoles: [{ role: "ADMIN", roleDefinitionId: "def-1" }],
      lodge: { id: "l-1", name: "Lodge" },
    });
  });

  it("keeps only the scalars of a relation selected with where alone", () => {
    expect(
      projectSelect(MEMBER, { accessRoles: { where: { role: "ADMIN" } } }),
    ).toEqual({ accessRoles: [{ role: "ADMIN", roleDefinitionId: "def-1" }] });
  });

  it("keeps a relation's scalars plus its includes", () => {
    expect(
      projectSelect(MEMBER, { accessRoles: { include: { roleDefinition: true } } }),
    ).toEqual({
      accessRoles: [
        {
          role: "ADMIN",
          roleDefinitionId: "def-1",
          roleDefinition: { id: "def-1", bookingsLevel: "EDIT" },
        },
      ],
    });
  });

  it("never invents a field the fixture lacks", () => {
    expect(projectSelect({ id: "m-2" }, { id: true, canLogin: true })).toEqual({
      id: "m-2",
    });
  });
});

describe("projectInclude and honourSelect", () => {
  it("gives a bare query the row's scalars only", async () => {
    const find = honourSelect(vi.fn(async () => MEMBER));
    await expect(find({})).resolves.toEqual({
      id: "m-1",
      canLogin: false,
      createdAt: MEMBER.createdAt,
    });
  });

  it("gives an include query the scalars plus the included relation", () => {
    expect(projectInclude(MEMBER, { lodge: true })).toEqual({
      id: "m-1",
      canLogin: false,
      createdAt: MEMBER.createdAt,
      lodge: { id: "l-1", name: "Lodge" },
    });
  });

  it("prefers select over include, and passes a missing row through", async () => {
    const find = honourSelect(vi.fn(async () => MEMBER));
    await expect(find({ select: { canLogin: true } })).resolves.toEqual({
      canLogin: false,
    });
    const missing = honourSelect(vi.fn(async () => null));
    await expect(missing({ select: { canLogin: true } })).resolves.toBeNull();
  });
});
