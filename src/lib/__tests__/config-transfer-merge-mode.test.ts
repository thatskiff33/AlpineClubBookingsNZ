import { describe, expect, it } from "vitest";

import {
  canonicalValue,
  changedFields,
  planActionFor,
  rawHasValue,
  updateDataForMode,
} from "@/lib/config-transfer/import-types";

// Merge vs overwrite semantics for how an import writes fields onto an existing
// row. Merge keeps the target's value for blank/omitted bundle fields; overwrite
// writes everything. Creates are unaffected (they always use the full data).

describe("config-transfer import merge mode", () => {
  it("rawHasValue treats blank/absent as no-value but false/0/empty arrays as values", () => {
    expect(rawHasValue({ x: "hello" }, "x")).toBe(true);
    expect(rawHasValue({ x: "  " }, "x")).toBe(false); // whitespace only
    expect(rawHasValue({ x: "" }, "x")).toBe(false);
    expect(rawHasValue({}, "x")).toBe(false); // absent
    expect(rawHasValue({ x: false }, "x")).toBe(true); // boolean false is a value
    expect(rawHasValue({ x: 0 }, "x")).toBe(true); // 0 is a value
    expect(rawHasValue({ x: [] }, "x")).toBe(true); // explicit empty JSON list is a value
    expect(rawHasValue({ x: null }, "x")).toBe(false);
  });

  it("overwrite mode writes every field verbatim (blanks clear)", () => {
    const raw = { name: "New", notes: "" };
    const data = { name: "New", notes: null };
    expect(updateDataForMode("overwrite", raw, data)).toEqual({ name: "New", notes: null });
  });

  it("merge mode drops fields whose bundle source is blank/absent (keep existing)", () => {
    const raw = { name: "New", notes: "", active: false };
    const data = { name: "New", notes: null, active: false };
    // notes is blank in the bundle → omitted so the target keeps its value;
    // name and the boolean active are real values → written.
    expect(updateDataForMode("merge", raw, data)).toEqual({ name: "New", active: false });
  });

  it("merge mode with an all-blank row yields an empty (no-op) update", () => {
    const raw = { a: "", b: "   " };
    const data = { a: null, b: null };
    expect(updateDataForMode("merge", raw, data)).toEqual({});
  });
});

describe("config-transfer dry-run change detection", () => {
  it("canonicalValue compares typed values without false positives", () => {
    // null/undefined/"" all canonicalise to the same empty form.
    expect(canonicalValue(null)).toBe(canonicalValue(undefined));
    expect(canonicalValue("")).toBe(canonicalValue(null));
    // A Date and the ISO string that represents it canonicalise identically —
    // so a bundle-side "2026-06-01" cell equals a DB-side @db.Date column, and
    // a JSON-serialised DateTime string equals its DB Date.
    expect(canonicalValue(new Date("2026-06-01T00:00:00.000Z"))).toBe(
      canonicalValue("2026-06-01"),
    );
    expect(canonicalValue(new Date("2026-06-01T10:30:00.000Z"))).toBe(
      canonicalValue("2026-06-01T10:30:00.000Z"),
    );
    // An invalid date (e.g. blank date cell) is treated as empty, never throws.
    expect(canonicalValue(new Date("not-a-date"))).toBe("");
    expect(canonicalValue(5000)).toBe("5000");
    expect(canonicalValue(false)).toBe("false");
  });

  it("changedFields returns only fields that actually differ", () => {
    const write = { name: "New", sortOrder: 2, startDate: new Date("2026-06-01T00:00:00.000Z") };
    const current = { name: "Old", sortOrder: 2, startDate: new Date("2026-06-01T00:00:00.000Z") };
    // Only name differs; sortOrder equal; date equal (no false positive).
    expect(changedFields(write, current)).toEqual(["name"]);
    // No current row → create → nothing to diff.
    expect(changedFields(write, null)).toEqual([]);
  });

  it("planActionFor reclassifies a no-op update as unchanged", () => {
    expect(planActionFor(null, [])).toBe("create");
    expect(planActionFor({ x: 1 }, [])).toBe("unchanged");
    expect(planActionFor({ x: 1 }, ["name"])).toBe("update");
  });

  it("merge keeps existing (unchanged) where overwrite would clear (changed)", () => {
    // Bundle leaves notes blank; target has notes.
    const raw = { notes: "" };
    const current = { notes: "existing note" };
    const mergeWrite = updateDataForMode("merge", raw, { notes: null });
    expect(planActionFor(current, changedFields(mergeWrite, current))).toBe("unchanged");
    const overwriteWrite = updateDataForMode("overwrite", raw, { notes: null });
    expect(planActionFor(current, changedFields(overwriteWrite, current))).toBe("update");
  });
});
