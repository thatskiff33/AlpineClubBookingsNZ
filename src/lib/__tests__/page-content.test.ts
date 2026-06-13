import { describe, expect, it } from "vitest";
import {
  isReservedPageSlug,
  isValidPageSlug,
  normalizePageSlug,
  toPagePath,
} from "@/lib/page-content";

describe("normalizePageSlug", () => {
  it("trims, lowercases, and strips surrounding slashes", () => {
    expect(normalizePageSlug("  /Trip-Reports/  ")).toBe("trip-reports");
  });

  it("collapses repeated slashes between segments", () => {
    expect(normalizePageSlug("join//apply")).toBe("join/apply");
  });
});

describe("isValidPageSlug", () => {
  it("accepts single-segment slugs", () => {
    expect(isValidPageSlug("trip-reports")).toBe(true);
    expect(isValidPageSlug("about")).toBe(true);
    expect(isValidPageSlug("2026-agm")).toBe(true);
  });

  it("accepts multi-segment slugs", () => {
    expect(isValidPageSlug("join/apply")).toBe(true);
    expect(isValidPageSlug("trips/2026/ruapehu")).toBe(true);
  });

  it("rejects malformed slugs", () => {
    expect(isValidPageSlug("")).toBe(false);
    expect(isValidPageSlug("Trip-Reports")).toBe(false);
    expect(isValidPageSlug("-leading")).toBe(false);
    expect(isValidPageSlug("trailing-")).toBe(false);
    expect(isValidPageSlug("/leading-slash")).toBe(false);
    expect(isValidPageSlug("trailing-slash/")).toBe(false);
    expect(isValidPageSlug("two//slashes")).toBe(false);
    expect(isValidPageSlug("has space")).toBe(false);
    expect(isValidPageSlug("under_score")).toBe(false);
  });
});

describe("isReservedPageSlug", () => {
  it("rejects reserved names as a whole slug", () => {
    expect(isReservedPageSlug("admin")).toBe(true);
    expect(isReservedPageSlug("api")).toBe(true);
    expect(isReservedPageSlug("login")).toBe(true);
  });

  it("rejects reserved names in any segment position", () => {
    expect(isReservedPageSlug("admin/settings")).toBe(true);
    expect(isReservedPageSlug("api/pages")).toBe(true);
    expect(isReservedPageSlug("trips/book")).toBe(true);
  });

  it("allows non-reserved slugs, including code-backed page slugs", () => {
    expect(isReservedPageSlug("about")).toBe(false);
    expect(isReservedPageSlug("join/apply")).toBe(false);
    expect(isReservedPageSlug("contact")).toBe(false);
    expect(isReservedPageSlug("home")).toBe(false);
    expect(isReservedPageSlug("rules")).toBe(false);
  });
});

describe("toPagePath", () => {
  it("prefixes the slug with a slash", () => {
    expect(toPagePath("about")).toBe("/about");
    expect(toPagePath("join/apply")).toBe("/join/apply");
  });
});
