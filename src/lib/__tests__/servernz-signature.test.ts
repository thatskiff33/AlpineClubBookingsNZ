import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  centralAvailabilitySignedText,
  SERVERNZ_SIGNATURE_TOLERANCE_MS,
  verifyServerNzSignature,
} from "@/lib/servernz-signature";

// The one Alpine Central Server signature check, shared by the shared-post
// doorbell and the availability question (#2992, #62).

const SECRET = "s".repeat(64);
const NOW = Date.parse("2026-07-01T00:00:00.000Z");

function sign(text: string, timestamp: string, secret = SECRET) {
  return createHmac("sha256", secret).update(`${timestamp}.${text}`).digest("hex");
}

function check(text: string, over: { timestamp?: string; signature?: string; signedText?: string } = {}) {
  const timestamp = over.timestamp ?? String(NOW);
  return verifyServerNzSignature({
    secret: SECRET,
    timestamp,
    signature: over.signature ?? sign(text, timestamp),
    signedText: over.signedText ?? text,
    now: NOW,
  });
}

describe("verifyServerNzSignature", () => {
  it("accepts a correct signature inside the window, at either edge", () => {
    expect(check("hello")).toEqual({ ok: true });
    expect(check("hello", { timestamp: String(NOW - SERVERNZ_SIGNATURE_TOLERANCE_MS) })).toEqual({ ok: true });
    expect(check("hello", { timestamp: String(NOW + SERVERNZ_SIGNATURE_TOLERANCE_MS) })).toEqual({ ok: true });
  });

  it("refuses a timestamp one millisecond outside the window, either way", () => {
    expect(check("hello", { timestamp: String(NOW - SERVERNZ_SIGNATURE_TOLERANCE_MS - 1) })).toEqual({
      ok: false,
      error: "Timestamp out of range",
    });
    expect(check("hello", { timestamp: String(NOW + SERVERNZ_SIGNATURE_TOLERANCE_MS + 1) })).toEqual({
      ok: false,
      error: "Timestamp out of range",
    });
  });

  it("keeps the doorbell's original rule: a missing timestamp reads as 0 and fails the window", () => {
    expect(check("hello", { timestamp: "" })).toEqual({ ok: false, error: "Timestamp out of range" });
    expect(check("hello", { timestamp: "soon" })).toEqual({ ok: false, error: "Invalid timestamp" });
  });

  it("refuses a different text, a wrong signature, and a signature of another length", () => {
    expect(check("hello", { signedText: "hellp" })).toEqual({ ok: false, error: "Invalid signature" });
    expect(check("hello", { signature: "0".repeat(64) })).toEqual({ ok: false, error: "Invalid signature" });
    // timingSafeEqual would THROW on unequal lengths; the guard answers instead.
    expect(check("hello", { signature: "abc" })).toEqual({ ok: false, error: "Invalid signature" });
    expect(check("hello", { signature: "" })).toEqual({ ok: false, error: "Invalid signature" });
  });
});

describe("centralAvailabilitySignedText", () => {
  it("is the domain prefix and the three values, one per line", () => {
    expect(centralAvailabilitySignedText({ lodgeId: "ol_a", from: "2026-07-10", to: "2026-07-13" })).toBe(
      "availability\nol_a\n2026-07-10\n2026-07-13",
    );
  });

  it("can never equal a push body, so neither route accepts the other's signature", () => {
    const text = centralAvailabilitySignedText({ lodgeId: "{", from: "", to: "" });
    expect(text.startsWith("availability")).toBe(true);
    expect(text.startsWith("{")).toBe(false);
  });
});
