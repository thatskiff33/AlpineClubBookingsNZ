import { describe, it, expect } from "vitest";
import {
  getParentEmailSourceId,
  buildParentLinks,
  resolveParentNotificationSourceId,
} from "@/lib/member-parent-links";

describe("getParentEmailSourceId", () => {
  it("returns null for a missing parent", () => {
    expect(getParentEmailSourceId(null)).toBeNull();
    expect(getParentEmailSourceId(undefined)).toBeNull();
  });

  it("prefers the parent's own inheritEmailFromId when set", () => {
    expect(
      getParentEmailSourceId({ id: "p1", inheritEmailFromId: "grandparent-1" }),
    ).toBe("grandparent-1");
  });

  it("falls back to the parent id when it inherits from no one", () => {
    expect(getParentEmailSourceId({ id: "p1", inheritEmailFromId: null })).toBe("p1");
    expect(getParentEmailSourceId({ id: "p1" })).toBe("p1");
  });
});

describe("resolveParentNotificationSourceId", () => {
  const links = [
    { id: "parent-1", inheritEmailFromId: null },
    { id: "parent-2", inheritEmailFromId: "grandparent-9" },
  ];

  // The crux of the admin family-group approve flow: the "Use child's own email"
  // option sends an EMPTY STRING (the <option value=""> in the notification-parent
  // picker), which must resolve to null — i.e. no inheritance, the child keeps its
  // own email. Callers rely on this coercion (see admin-family-group-requests-service
  // and the reviewFamilyGroupRequestSchema `.or(z.literal(""))`), so lock it in.
  it("treats an empty string as 'no inheritance' (use own email → null)", () => {
    expect(resolveParentNotificationSourceId(links, "")).toBeNull();
  });

  it("treats whitespace-only, null, and undefined the same as empty (null)", () => {
    expect(resolveParentNotificationSourceId(links, "   ")).toBeNull();
    expect(resolveParentNotificationSourceId(links, null)).toBeNull();
    expect(resolveParentNotificationSourceId(links, undefined)).toBeNull();
  });

  it("resolves a selected parent id to that parent's email-source id", () => {
    // parent-1 inherits from no one → its own id is the source
    expect(resolveParentNotificationSourceId(links, "parent-1")).toBe("parent-1");
    // parent-2 itself inherits from grandparent-9 → follow the chain
    expect(resolveParentNotificationSourceId(links, "parent-2")).toBe("grandparent-9");
  });

  it("accepts a selection that already names a parent's email-source id", () => {
    expect(resolveParentNotificationSourceId(links, "grandparent-9")).toBe("grandparent-9");
  });

  it("returns undefined for a selection matching no linked parent", () => {
    expect(resolveParentNotificationSourceId(links, "stranger-1")).toBeUndefined();
  });

  it("trims a padded but valid selection before matching", () => {
    expect(resolveParentNotificationSourceId(links, "  parent-1  ")).toBe("parent-1");
  });
});

describe("buildParentLinks", () => {
  const base = {
    firstName: "A",
    lastName: "B",
    email: "a@b.test",
  };

  it("includes primary and distinct secondary parents", () => {
    const links = buildParentLinks({
      parent: { id: "p1", ...base },
      secondaryParent: { id: "p2", ...base },
    });
    expect(links.map((l) => l.id)).toEqual(["p1", "p2"]);
    expect(links.map((l) => l.parentLinkType)).toEqual(["PRIMARY", "SECONDARY"]);
  });

  it("drops a secondary parent that duplicates the primary", () => {
    const links = buildParentLinks({
      parent: { id: "p1", ...base },
      secondaryParent: { id: "p1", ...base },
    });
    expect(links.map((l) => l.id)).toEqual(["p1"]);
  });

  it("returns an empty list when there are no parents", () => {
    expect(buildParentLinks({})).toEqual([]);
  });
});
