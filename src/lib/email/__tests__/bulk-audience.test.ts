import { describe, expect, it } from "vitest";
import { partitionBulkAudience } from "@/lib/email/bulk-audience";

// #4987, INV-PRIV-023: the one rule deciding who a bulk email reaches. A club
// notice is opt-out; a newsletter is opt-in, and must stay opt-in for a member
// who never saved preferences.
const noRow = { id: "no-row", notificationPreference: null };
const allOn = {
  id: "all-on",
  notificationPreference: { clubNotices: true, marketingEmails: true },
};
const defaults = {
  id: "defaults",
  notificationPreference: { clubNotices: true, marketingEmails: false },
};
const allOff = {
  id: "all-off",
  notificationPreference: { clubNotices: false, marketingEmails: false },
};
const newsletterOnly = {
  id: "newsletter-only",
  notificationPreference: { clubNotices: false, marketingEmails: true },
};
const members = [noRow, allOn, defaults, allOff, newsletterOnly];

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe("partitionBulkAudience", () => {
  it("sends a club notice to everyone who has not turned club notices off, including members with no saved preferences", () => {
    const result = partitionBulkAudience(members, "clubNotice");
    expect(ids(result.eligible)).toEqual(["no-row", "all-on", "defaults"]);
    expect(ids(result.optedOut)).toEqual(["all-off", "newsletter-only"]);
    expect(result.neverOptedIn).toEqual([]);
  });

  it("sends a newsletter only to members who turned newsletters on", () => {
    const result = partitionBulkAudience(members, "newsletter");
    expect(ids(result.eligible)).toEqual(["all-on", "newsletter-only"]);
    expect(ids(result.optedOut)).toEqual(["defaults", "all-off"]);
    expect(ids(result.neverOptedIn)).toEqual(["no-row"]);
  });

  it("never sends a newsletter to a member with no saved preferences", () => {
    const result = partitionBulkAudience([noRow], "newsletter");
    expect(result.eligible).toEqual([]);
  });
});
