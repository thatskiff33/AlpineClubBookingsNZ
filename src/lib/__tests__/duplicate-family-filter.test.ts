/**
 * Tests for Issues #17 and #18:
 * - #17: Duplicate scan suppresses contacts already in a common Family Group
 * - #18: Duplicate scan enriches groups with member info for family group creation
 */
import { describe, it, expect } from "vitest";

// ─── #17: Family group filtering logic ──────────────────────────────────────

describe("Duplicate contact family group filtering logic", () => {
  // Replicate the filtering algorithm from findDuplicateContacts
  function filterByFamilyGroups(
    duplicateGroups: { email: string; contacts: { contactID: string }[] }[],
    contactToGroupIds: Map<string, Set<string>>
  ) {
    return duplicateGroups.filter((group) => {
      const groupSets = group.contacts.map((c) =>
        contactToGroupIds.get(c.contactID)
      );
      if (groupSets.some((s) => !s || s.size === 0)) return true;
      const intersection = groupSets.reduce((acc, curr) => {
        const result = new Set<string>();
        for (const id of acc!) {
          if (curr!.has(id)) result.add(id);
        }
        return result;
      })!;
      return intersection.size === 0;
    });
  }

  it("excludes groups where all contacts share a common family group", () => {
    const groups = [
      {
        email: "smith@example.com",
        contacts: [{ contactID: "c1" }, { contactID: "c2" }],
      },
    ];
    const map = new Map<string, Set<string>>();
    map.set("c1", new Set(["fg1"]));
    map.set("c2", new Set(["fg1"]));

    const result = filterByFamilyGroups(groups, map);
    expect(result).toHaveLength(0);
  });

  it("keeps groups where contacts have no common family group", () => {
    const groups = [
      {
        email: "diff@example.com",
        contacts: [{ contactID: "c1" }, { contactID: "c2" }],
      },
    ];
    const map = new Map<string, Set<string>>();
    map.set("c1", new Set(["fg1"]));
    map.set("c2", new Set(["fg2"]));

    const result = filterByFamilyGroups(groups, map);
    expect(result).toHaveLength(1);
  });

  it("keeps groups where some contacts have no matching member", () => {
    const groups = [
      {
        email: "partial@example.com",
        contacts: [{ contactID: "c1" }, { contactID: "c2" }, { contactID: "c3" }],
      },
    ];
    const map = new Map<string, Set<string>>();
    map.set("c1", new Set(["fg1"]));
    map.set("c2", new Set(["fg1"]));
    // c3 has no entry — not in DB

    const result = filterByFamilyGroups(groups, map);
    expect(result).toHaveLength(1);
  });

  it("excludes when contacts share one of multiple family groups", () => {
    const groups = [
      {
        email: "multi@example.com",
        contacts: [{ contactID: "c1" }, { contactID: "c2" }],
      },
    ];
    const map = new Map<string, Set<string>>();
    map.set("c1", new Set(["fg1", "fg2"]));
    map.set("c2", new Set(["fg2", "fg3"]));

    const result = filterByFamilyGroups(groups, map);
    expect(result).toHaveLength(0); // fg2 is common
  });

  it("keeps groups where a contact has no family groups", () => {
    const groups = [
      {
        email: "nofg@example.com",
        contacts: [{ contactID: "c1" }, { contactID: "c2" }],
      },
    ];
    const map = new Map<string, Set<string>>();
    map.set("c1", new Set(["fg1"]));
    map.set("c2", new Set()); // member exists but no family groups

    const result = filterByFamilyGroups(groups, map);
    expect(result).toHaveLength(1);
  });

  it("handles mixed: some groups filtered, some kept", () => {
    const groups = [
      {
        email: "family@example.com",
        contacts: [{ contactID: "c1" }, { contactID: "c2" }],
      },
      {
        email: "nofamily@example.com",
        contacts: [{ contactID: "c3" }, { contactID: "c4" }],
      },
    ];
    const map = new Map<string, Set<string>>();
    map.set("c1", new Set(["fg1"]));
    map.set("c2", new Set(["fg1"]));
    // c3 and c4 not in map

    const result = filterByFamilyGroups(groups, map);
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe("nofamily@example.com");
  });

  it("returns correct filteredByFamilyGroup count", () => {
    const groups = [
      { email: "a@e.com", contacts: [{ contactID: "c1" }, { contactID: "c2" }] },
      { email: "b@e.com", contacts: [{ contactID: "c3" }, { contactID: "c4" }] },
      { email: "c@e.com", contacts: [{ contactID: "c5" }, { contactID: "c6" }] },
    ];
    const map = new Map<string, Set<string>>();
    map.set("c1", new Set(["fg1"]));
    map.set("c2", new Set(["fg1"]));
    map.set("c3", new Set(["fg2"]));
    map.set("c4", new Set(["fg2"]));
    // c5, c6 not in map

    const result = filterByFamilyGroups(groups, map);
    const filteredCount = groups.length - result.length;

    expect(result).toHaveLength(1);
    expect(filteredCount).toBe(2);
  });
});

// ─── #18: Duplicate group enrichment for family group creation ──────────────

describe("Duplicate group enrichment logic", () => {
  interface EnrichedContact {
    contactID: string;
    name: string;
    firstName?: string;
    lastName?: string;
    memberId?: string;
    memberActive?: boolean;
  }

  interface EnrichedGroup {
    email: string;
    contacts: EnrichedContact[];
    canCreateFamilyGroup: boolean;
    eligibleMemberIds: string[];
    suggestedGroupName?: string;
  }

  // Replicate the enrichment logic from findDuplicateContacts
  function enrichGroup(
    group: { email: string; contacts: { contactID: string; name: string; firstName?: string; lastName?: string }[] },
    memberMap: Map<string, { id: string; firstName: string; lastName: string; active: boolean; canLogin: boolean }>
  ): EnrichedGroup {
    const enrichedContacts: EnrichedContact[] = group.contacts.map((c) => {
      const member = memberMap.get(c.contactID);
      return {
        ...c,
        memberId: member?.id,
        memberActive: member?.active,
      };
    });

    const eligibleMembers = enrichedContacts
      .filter((c) => {
        const member = memberMap.get(c.contactID);
        return member && member.canLogin;
      })
      .map((c) => memberMap.get(c.contactID)!);

    const eligibleMemberIds = eligibleMembers.map((m) => m.id);
    const canCreateFamilyGroup = eligibleMemberIds.length >= 2;

    let suggestedGroupName: string | undefined;
    if (canCreateFamilyGroup) {
      const lastNames = [...new Set(eligibleMembers.map((m) => m.lastName))];
      if (lastNames.length === 1) {
        suggestedGroupName = `${lastNames[0]} Family`;
      }
    }

    return {
      email: group.email,
      contacts: enrichedContacts,
      canCreateFamilyGroup,
      eligibleMemberIds,
      suggestedGroupName,
    };
  }

  it("sets canCreateFamilyGroup when 2+ contacts map to non-dependent members", () => {
    const group = {
      email: "smith@example.com",
      contacts: [
        { contactID: "c1", name: "Alice Smith", firstName: "Alice", lastName: "Smith" },
        { contactID: "c2", name: "Bob Smith", firstName: "Bob", lastName: "Smith" },
      ],
    };
    const memberMap = new Map([
      ["c1", { id: "m1", firstName: "Alice", lastName: "Smith", active: true, canLogin: true }],
      ["c2", { id: "m2", firstName: "Bob", lastName: "Smith", active: true, canLogin: true }],
    ]);

    const result = enrichGroup(group, memberMap);
    expect(result.canCreateFamilyGroup).toBe(true);
    expect(result.eligibleMemberIds).toEqual(["m1", "m2"]);
    expect(result.suggestedGroupName).toBe("Smith Family");
  });

  it("excludes dependents from eligible members", () => {
    const group = {
      email: "jones@example.com",
      contacts: [
        { contactID: "c1", name: "Parent Jones", firstName: "Parent", lastName: "Jones" },
        { contactID: "c2", name: "Child Jones", firstName: "Child", lastName: "Jones" },
      ],
    };
    const memberMap = new Map([
      ["c1", { id: "m1", firstName: "Parent", lastName: "Jones", active: true, canLogin: true }],
      ["c2", { id: "m2", firstName: "Child", lastName: "Jones", active: true, canLogin: false }],
    ]);

    const result = enrichGroup(group, memberMap);
    expect(result.canCreateFamilyGroup).toBe(false);
    expect(result.eligibleMemberIds).toEqual(["m1"]);
  });

  it("does not suggest group name when last names differ", () => {
    const group = {
      email: "shared@example.com",
      contacts: [
        { contactID: "c1", name: "Alice Smith", firstName: "Alice", lastName: "Smith" },
        { contactID: "c2", name: "Bob Jones", firstName: "Bob", lastName: "Jones" },
      ],
    };
    const memberMap = new Map([
      ["c1", { id: "m1", firstName: "Alice", lastName: "Smith", active: true, canLogin: true }],
      ["c2", { id: "m2", firstName: "Bob", lastName: "Jones", active: true, canLogin: true }],
    ]);

    const result = enrichGroup(group, memberMap);
    expect(result.canCreateFamilyGroup).toBe(true);
    expect(result.suggestedGroupName).toBeUndefined();
  });

  it("handles contacts with no matching member", () => {
    const group = {
      email: "test@example.com",
      contacts: [
        { contactID: "c1", name: "Known Member", firstName: "Known", lastName: "Member" },
        { contactID: "c2", name: "Unknown Contact" },
      ],
    };
    const memberMap = new Map([
      ["c1", { id: "m1", firstName: "Known", lastName: "Member", active: true, canLogin: true }],
    ]);

    const result = enrichGroup(group, memberMap);
    expect(result.canCreateFamilyGroup).toBe(false);
    expect(result.eligibleMemberIds).toEqual(["m1"]);
    expect(result.contacts[0].memberId).toBe("m1");
    expect(result.contacts[1].memberId).toBeUndefined();
  });

  it("enriches contacts with memberId and memberActive", () => {
    const group = {
      email: "test@example.com",
      contacts: [
        { contactID: "c1", name: "Active", firstName: "Active", lastName: "User" },
        { contactID: "c2", name: "Inactive", firstName: "Inactive", lastName: "User" },
      ],
    };
    const memberMap = new Map([
      ["c1", { id: "m1", firstName: "Active", lastName: "User", active: true, canLogin: true }],
      ["c2", { id: "m2", firstName: "Inactive", lastName: "User", active: false, canLogin: true }],
    ]);

    const result = enrichGroup(group, memberMap);
    expect(result.contacts[0].memberId).toBe("m1");
    expect(result.contacts[0].memberActive).toBe(true);
    expect(result.contacts[1].memberId).toBe("m2");
    expect(result.contacts[1].memberActive).toBe(false);
    // Both are eligible (inactive allowed per issue #16)
    expect(result.canCreateFamilyGroup).toBe(true);
  });
});
