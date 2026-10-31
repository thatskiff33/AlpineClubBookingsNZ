import { describe, expect, it } from "vitest";

import {
  committeeRoleCreateSchema,
  committeeRoleFormSchema,
  committeeRolePatchSchema,
} from "@/lib/forms/committee-role-schema";

// #4467: one set of field rules for the role form and both role routes. The
// point of sharing them is that whatever the form lets through, the routes
// accept — so that is asserted, not assumed.

const filled = {
  name: "  Treasurer ",
  description: "",
  contactEmail: "",
  sortOrder: 3,
  isActive: true,
};

describe("committee role schemas", () => {
  it("turns the form's values into the payload the form always sent", () => {
    expect(committeeRoleFormSchema.parse(filled)).toEqual({
      name: "Treasurer",
      description: null,
      contactEmail: null,
      sortOrder: 3,
      isActive: true,
    });
  });

  it("sends what both routes accept", () => {
    const payload = committeeRoleFormSchema.parse({
      ...filled,
      description: "Looks after the money",
      contactEmail: " treasurer@example.org ",
    });
    expect(committeeRoleCreateSchema.safeParse(payload).success).toBe(true);
    expect(committeeRolePatchSchema.safeParse(payload).success).toBe(true);
  });

  it("refuses in the browser what the routes refuse, with the same message", () => {
    const bad = { ...filled, name: "   ", contactEmail: "not-an-email" };
    const form = committeeRoleFormSchema.safeParse(bad);
    const route = committeeRoleCreateSchema.safeParse({
      ...bad,
      description: null,
    });
    expect(form.success).toBe(false);
    expect(route.success).toBe(false);
    expect(form.error?.flatten().fieldErrors).toEqual(route.error?.flatten().fieldErrors);
    expect(form.error?.flatten().fieldErrors).toEqual({
      name: ["Enter a role name"],
      contactEmail: ["Enter the role email as an address, like president@example.org"],
    });
  });

  it("states its limits as an officer reads them, with a thousands separator", () => {
    const messages = (input: unknown) =>
      committeeRoleCreateSchema.safeParse(input).error?.issues.map((issue) => issue.message) ?? [];
    expect(messages({ name: "Chair", description: "x".repeat(1_001) })).toContain(
      "Use a description of 1,000 characters or fewer",
    );
    expect(messages({ name: "Chair", sortOrder: 100_001 })).toContain(
      "Enter a sort order of 100,000 or less",
    );
  });

  it("keeps create's isActive default and gives PATCH none", () => {
    expect(committeeRoleCreateSchema.parse({ name: "Chair" }).isActive).toBe(true);
    // A default on PATCH would re-activate an archived role on a rename.
    expect(committeeRolePatchSchema.parse({ name: "Chair" })).toEqual({ name: "Chair" });
  });

  it("stays strict on both routes", () => {
    expect(committeeRoleCreateSchema.safeParse({ name: "Chair", key: "x" }).success).toBe(false);
    expect(committeeRolePatchSchema.safeParse({ key: "x" }).success).toBe(false);
  });
});
