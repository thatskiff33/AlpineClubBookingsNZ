import { describe, expect, it } from "vitest";
import {
  financeAccessShortLabels,
  getLifecycleStatusConfig,
  getLoginBadge,
  LOGIN_BADGE,
  NON_LOGIN_BADGE,
} from "@/lib/admin-member-badges";

describe("admin-member-badges", () => {
  it("exposes the short finance access labels", () => {
    expect(financeAccessShortLabels.MANAGER).toBe("Manager");
    expect(financeAccessShortLabels.NONE).toBe("None");
  });

  describe("getLifecycleStatusConfig", () => {
    it("returns Archived when archivedAt is set", () => {
      const config = getLifecycleStatusConfig({
        active: true,
        cancelledAt: new Date(),
        archivedAt: new Date(),
      });
      expect(config.label).toBe("Archived");
      expect(config.className).toContain("bg-accent");
    });

    it("returns Cancelled when only cancelledAt is set", () => {
      const config = getLifecycleStatusConfig({
        active: false,
        cancelledAt: new Date(),
        archivedAt: null,
      });
      expect(config.label).toBe("Cancelled");
      expect(config.className).toContain("warning");
    });

    it("returns Active for an active member with no lifecycle flags", () => {
      const config = getLifecycleStatusConfig({
        active: true,
        cancelledAt: null,
        archivedAt: null,
      });
      expect(config.label).toBe("Active");
      expect(config.className).toContain("success");
    });

    it("returns Inactive when active is false and no lifecycle flags are set", () => {
      const config = getLifecycleStatusConfig({
        active: false,
        cancelledAt: null,
        archivedAt: null,
      });
      expect(config.label).toBe("Inactive");
      expect(config.className).toBe("");
    });

    // #2620. Deletion anonymisation writes `active: false` and stamps neither
    // cancelledAt nor archivedAt, so without the flag an erased account renders
    // "Inactive" — visually identical to a member deactivated yesterday, which is
    // how one could be swept into a bulk Reactivate by accident.
    it("returns Deleted for an anonymised account instead of Inactive", () => {
      const config = getLifecycleStatusConfig({
        active: false,
        cancelledAt: null,
        archivedAt: null,
        deletedAccount: true,
      });
      expect(config.label).toBe("Deleted");
      expect(config.className).toContain("danger");
    });

    it("prefers Deleted over Archived and Cancelled", () => {
      const config = getLifecycleStatusConfig({
        active: false,
        cancelledAt: new Date(),
        archivedAt: new Date(),
        deletedAccount: true,
      });
      expect(config.label).toBe("Deleted");
    });

    it("still returns Inactive when the deleted flag is absent or false", () => {
      expect(
        getLifecycleStatusConfig({
          active: false,
          cancelledAt: null,
          archivedAt: null,
          deletedAccount: false,
        }).label,
      ).toBe("Inactive");
    });

    it("accepts ISO strings for cancelledAt and archivedAt", () => {
      const config = getLifecycleStatusConfig({
        active: false,
        cancelledAt: "2026-05-25T00:00:00.000Z",
        archivedAt: null,
      });
      expect(config.label).toBe("Cancelled");
    });
  });

  describe("getLoginBadge", () => {
    it("returns the can-login badge when canLogin is true", () => {
      expect(getLoginBadge(true)).toEqual(LOGIN_BADGE);
    });

    it("returns the non-login badge when canLogin is false", () => {
      expect(getLoginBadge(false)).toEqual(NON_LOGIN_BADGE);
    });
  });
});
