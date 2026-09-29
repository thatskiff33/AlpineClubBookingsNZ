import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { describe, expect, it } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";
import { resolveDisplayText } from "@/lib/lodge-display/display-text";
import { listDisplayCssTokens } from "@/lib/lodge-display/css-tokens";
import {
  DISPLAY_CONFIG_KEY_PATTERN,
  DISPLAY_STANDARD_TOKENS,
  displayConfigToken,
  isValidDisplayConfigKey,
  listDisplayCssInsertTokens,
  normaliseDisplayConfigKey,
  suggestDisplayConfigKey,
  unsetDisplayConfigPlaceholder,
} from "@/lib/lodge-display/display-token-catalogue";

// #2248: the token assistant's catalogue must stay in LOCKSTEP with the real
// display grammar — every entry it offers resolves through display-text.ts, its
// key rule matches the lodge-config route's save-side validation (the route now
// imports DISPLAY_CONFIG_KEY_PATTERN, so that pairing cannot drift), and its
// CSS list is generated from listDisplayCssTokens(), never hand-copied. These
// tests exercise the REAL resolver, not a re-statement of it.

function state(overrides: Partial<DisplayState> = {}): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: [],
    chores: [],
    rules: null,
    notice: null,
    config: { "wifi-code": "alpine1234" },
    capabilities: { bedAllocation: false, chores: false },
    ...overrides,
  } as DisplayState;
}

describe("standard tokens are the closed grammar, verbatim", () => {
  it("every standard token resolves through the real resolver (none passes through verbatim)", () => {
    const s = state();
    for (const entry of DISPLAY_STANDARD_TOKENS) {
      // A token outside the closed grammar would be left VERBATIM by
      // resolveDisplayText — so "resolved ≠ input" proves grammar membership.
      expect(resolveDisplayText(entry.token, s, CLUB_FORMAT_TEST)).not.toBe(entry.token);
    }
  });

  it("offers exactly lodge-name and display-date (extending the grammar means extending display-text.ts first)", () => {
    expect(DISPLAY_STANDARD_TOKENS.map((t) => t.token)).toEqual([
      "{{lodge-name}}",
      "{{display-date}}",
    ]);
  });
});

describe("config tokens", () => {
  it("displayConfigToken produces a token the resolver substitutes with the saved value", () => {
    const s = state();
    expect(resolveDisplayText(displayConfigToken("wifi-code"), s, CLUB_FORMAT_TEST)).toBe(
      "alpine1234"
    );
  });

  it("unsetDisplayConfigPlaceholder matches the resolver's actual unset-key output byte for byte", () => {
    // Decision 3: the picker's warning names the EXACT placeholder the wall
    // will render, so it is asserted against the real resolver, not hand-typed.
    const s = state({ config: {} });
    expect(resolveDisplayText(displayConfigToken("kitchen-wifi"), s, CLUB_FORMAT_TEST)).toBe(
      unsetDisplayConfigPlaceholder("kitchen-wifi")
    );
    // Normalisation matches the resolver's case-insensitive key handling too.
    expect(unsetDisplayConfigPlaceholder("  Kitchen-Wifi ")).toBe(
      unsetDisplayConfigPlaceholder("kitchen-wifi")
    );
  });

  it("key validation accepts what the lodge-config route accepts and rejects the rest", () => {
    for (const valid of ["wifi-code", "a", "door-pin-2", "x".repeat(64)]) {
      expect(isValidDisplayConfigKey(valid)).toBe(true);
      expect(DISPLAY_CONFIG_KEY_PATTERN.test(valid)).toBe(true);
    }
    for (const invalid of [
      "",
      "Wi-Fi Code!",
      "-leading-hyphen",
      "UPPER",
      "x".repeat(65),
      "spaced key",
    ]) {
      expect(isValidDisplayConfigKey(invalid)).toBe(false);
    }
  });

  it("normalises a typed key the way the resolver matches it", () => {
    expect(normaliseDisplayConfigKey("  WIFI-Code ")).toBe("wifi-code");
  });

  it("suggests a salvageable slug for an invalid typed key, or nothing", () => {
    expect(suggestDisplayConfigKey("Wi-Fi Code!")).toBe("wi-fi-code");
    expect(suggestDisplayConfigKey("!!!")).toBe("");
    const suggestion = suggestDisplayConfigKey("Wi-Fi Code!");
    expect(isValidDisplayConfigKey(suggestion)).toBe(true);
  });
});

describe("CSS insert tokens", () => {
  it("is generated 1:1 from listDisplayCssTokens(), wrapping each name as var(--…)", () => {
    const source = listDisplayCssTokens();
    const inserts = listDisplayCssInsertTokens();
    expect(inserts.map((t) => t.name)).toEqual(source.map((t) => t.name));
    expect(inserts.map((t) => t.family)).toEqual(source.map((t) => t.family));
    for (const token of inserts) {
      expect(token.insertText).toBe(`var(${token.name})`);
    }
  });

  it("keeps the display's own palette first (ordered by safety)", () => {
    const inserts = listDisplayCssInsertTokens();
    const firstBrand = inserts.findIndex((t) => t.family === "brand");
    expect(firstBrand).toBeGreaterThan(0);
    expect(
      inserts.slice(0, firstBrand).every((t) => t.family === "display")
    ).toBe(true);
  });
});
