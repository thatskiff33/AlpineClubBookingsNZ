import { describe, expect, it } from "vitest";
import {
  defaultHiddenCalendarStatuses,
  readHiddenCalendarStatuses,
  writeHiddenCalendarStatuses,
} from "@/lib/admin-calendar-status-preference";

// A map-backed stand-in for localStorage, so the preference rules run in node.
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const HIDDEN = "admin-calendar-hidden-statuses";
const LEGACY = "admin-calendar-enabled-statuses";

describe("admin calendar status preference (#4923)", () => {
  it("hides only Cancelled when nothing is saved", () => {
    expect([...readHiddenCalendarStatuses(fakeStorage())]).toEqual(["CANCELLED"]);
  });

  it("reads the saved hidden list and ignores entries that are not booking statuses", () => {
    const storage = fakeStorage({ [HIDDEN]: '["AWAITING_REVIEW","NOT_A_STATUS","__proto__",42]' });
    expect([...readHiddenCalendarStatuses(storage)]).toEqual(["AWAITING_REVIEW"]);
  });

  it("falls back to the defaults for corrupt or non-list values", () => {
    for (const value of ["{not json", '"PAID"', "null"]) {
      expect(readHiddenCalendarStatuses(fakeStorage({ [HIDDEN]: value }))).toEqual(
        defaultHiddenCalendarStatuses()
      );
    }
  });

  it("falls back to the defaults when reading storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readHiddenCalendarStatuses(throwing)).toEqual(defaultHiddenCalendarStatuses());
  });

  it("converts a legacy enabled list: statuses it knew about and left out stay hidden", () => {
    const hidden = readHiddenCalendarStatuses(fakeStorage({ [LEGACY]: '["CONFIRMED","PAID"]' }));
    expect(hidden.has("DRAFT")).toBe(true);
    expect(hidden.has("CANCELLED")).toBe(true);
    expect(hidden.has("CONFIRMED")).toBe(false);
    expect(hidden.has("PAID")).toBe(false);
    // The legacy list never knew this status, so it must not count as hidden.
    expect(hidden.has("AWAITING_REVIEW")).toBe(false);
  });

  it("uses the defaults for a legacy list with no recognised status", () => {
    const storage = fakeStorage({ [LEGACY]: '["NOT_A_STATUS"]' });
    expect(readHiddenCalendarStatuses(storage)).toEqual(defaultHiddenCalendarStatuses());
  });

  it("prefers the new key over a legacy key left beside it", () => {
    const storage = fakeStorage({ [HIDDEN]: "[]", [LEGACY]: '["PAID"]' });
    expect(readHiddenCalendarStatuses(storage).size).toBe(0);
  });

  it("writes the hidden list and removes the legacy key", () => {
    const storage = fakeStorage({ [LEGACY]: '["PAID"]' });
    writeHiddenCalendarStatuses(storage, new Set(["BUMPED", "DRAFT"] as const));
    expect(JSON.parse(storage.data.get(HIDDEN)!)).toEqual(["BUMPED", "DRAFT"]);
    expect(storage.data.has(LEGACY)).toBe(false);
  });
});
