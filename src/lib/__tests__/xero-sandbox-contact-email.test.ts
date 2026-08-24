import { describe, expect, it } from "vitest";

import {
  DELETED_CONTACT_EMAIL_DOMAIN,
  INHERITANCE_LOST_CONTACT_EMAIL_DOMAIN,
  PLACEHOLDER_CONTACT_EMAIL_DOMAIN,
  PLACEHOLDER_CONTACT_EMAIL_DOMAINS,
  isPlaceholderContactEmail,
} from "@/lib/placeholder-contact-email";
import {
  XERO_SANDBOX_CONTACT_EMAIL_DOMAIN,
  isXeroContactEmailUnreachable,
  isXeroSandboxContactEmail,
  toXeroSandboxContactEmail,
  xeroPushableContactEmail,
  xeroSandboxContainmentTarget,
} from "@/lib/xero-sandbox-contact-email";

/**
 * INV-CONFIG-005: the contained address a copy puts on a Xero contact
 * (ENV-SAFETY 3, #3036; epic #2986).
 *
 * Pure: no database, no environment, no clock. Every property this address has to
 * carry is asserted here, and the two that are easiest to break by accident —
 * idempotency and the separation from placeholder semantics — are asserted from
 * both directions.
 */
describe("the contained Xero contact address (INV-CONFIG-005)", () => {
  const REAL = "member@example.com";

  it("is deterministic: the same address always maps to the same contained address", () => {
    const first = toXeroSandboxContactEmail(REAL);
    const second = toXeroSandboxContactEmail(REAL);
    expect(first).toBe(second);
    // And it really is derived from the address, not a constant: a different
    // member gets a different contained address, or a restored copy could not
    // tell two contacts apart.
    expect(toXeroSandboxContactEmail("other@example.com")).not.toBe(first);
  });

  it("ignores case and surrounding whitespace, so one member gets one address", () => {
    expect(toXeroSandboxContactEmail("  MEMBER@Example.COM ")).toBe(
      toXeroSandboxContactEmail(REAL),
    );
  });

  it("is non-deliverable: the reserved .invalid TLD (RFC 2606)", () => {
    const contained = toXeroSandboxContactEmail(REAL);
    expect(contained.endsWith(`@${XERO_SANDBOX_CONTACT_EMAIL_DOMAIN}`)).toBe(true);
    expect(XERO_SANDBOX_CONTACT_EMAIL_DOMAIN.endsWith(".invalid")).toBe(true);
  });

  it("has exactly the shape this feature's operator copy promises", () => {
    /*
      #3036 review P1-8b. Every case around this one asserts a PROPERTY -
      deterministic, idempotent, non-deliverable, short enough - and a mutant
      that changed the digest length, dropped the prefix or truncated to eight
      characters satisfied all of them. Nothing pinned the SHAPE, and the shape
      is a published promise: the changelog and the operator guide both tell an
      administrator to expect
      `contained-<letters and numbers>@xero-sandbox.invalid` and to recognise a
      contained contact by it, and `docs/guides/environment-role.md` says the
      same. So the shape is a contract with a person, not an implementation
      detail.

      128 bits of digest is the width, and it is a judgement worth pinning rather
      than drifting: the population is one address per Xero contact, so this is
      far past any collision concern, and the whole address stays inside every
      provider field limit.
    */
    const contained = toXeroSandboxContactEmail(REAL);
    expect(contained).toMatch(
      /^contained-[0-9a-f]{32}@xero-sandbox\.invalid$/,
    );
    // The domain constant and the literal above must be the same string, or this
    // case would be pinning a shape the module no longer produces.
    expect(XERO_SANDBOX_CONTACT_EMAIL_DOMAIN).toBe("xero-sandbox.invalid");
    expect(contained).toHaveLength("contained-".length + 32 + 1 + 20);
  });

  it("carries no part of the real address", () => {
    const contained = toXeroSandboxContactEmail(REAL);
    expect(contained).not.toContain("member");
    expect(contained).not.toContain("example.com");
  });

  it("fits comfortably inside a provider email field", () => {
    // Xero's email field is 255 characters. A long source address must not
    // produce a long contained one — the digest is fixed width.
    const long = `${"a".repeat(200)}@${"b".repeat(40)}.example.com`;
    expect(toXeroSandboxContactEmail(long).length).toBe(
      toXeroSandboxContactEmail(REAL).length,
    );
    expect(toXeroSandboxContactEmail(long).length).toBeLessThan(100);
  });

  it("NEVER double-wraps: containing a contained address returns it unchanged", () => {
    const once = toXeroSandboxContactEmail(REAL);
    const twice = toXeroSandboxContactEmail(once);
    const thrice = toXeroSandboxContactEmail(twice);
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  it("recognises its own addresses and nothing else", () => {
    expect(isXeroSandboxContactEmail(toXeroSandboxContactEmail(REAL))).toBe(true);
    expect(isXeroSandboxContactEmail(REAL)).toBe(false);
    expect(isXeroSandboxContactEmail("")).toBe(false);
    expect(isXeroSandboxContactEmail(null)).toBe(false);
    expect(isXeroSandboxContactEmail(undefined)).toBe(false);
    // Case-insensitive, because Xero returns whatever was typed.
    expect(
      isXeroSandboxContactEmail(
        toXeroSandboxContactEmail(REAL).toUpperCase(),
      ),
    ).toBe(true);
  });

  it("leaves blank blank", () => {
    expect(toXeroSandboxContactEmail("")).toBe("");
    expect(toXeroSandboxContactEmail("   ")).toBe("");
    expect(toXeroSandboxContactEmail(null)).toBe("");
    expect(toXeroSandboxContactEmail(undefined)).toBe("");
  });

  /**
   * THE SEPARATION THAT MUST NOT ERODE, asserted in both directions.
   *
   * `isPlaceholderContactEmail` is what the mailer, the reminder crons, email
   * inheritance, the non-member-contact service, deleted accounts and three Xero
   * modules read as "this person cannot be reached". A contained member CAN be
   * reached — on the live site, by the club — so the contained domain must never
   * join that list. If it did, every contained member in a copy would read as
   * unreachable and the copy would stop behaving like production, which is the
   * property this issue exists to keep (invoices stay AUTHORISED, settlement
   * stays testable).
   */
  describe("placeholder semantics stay separate", () => {
    it("the contained domain is not one of the placeholder domains", () => {
      expect(PLACEHOLDER_CONTACT_EMAIL_DOMAINS).not.toContain(
        XERO_SANDBOX_CONTACT_EMAIL_DOMAIN,
      );
      // Anti-vacuity: the list really is the one the predicate reads, and it
      // really does hold the three domains it is supposed to.
      expect([...PLACEHOLDER_CONTACT_EMAIL_DOMAINS].sort()).toEqual(
        [
          DELETED_CONTACT_EMAIL_DOMAIN,
          INHERITANCE_LOST_CONTACT_EMAIL_DOMAIN,
          PLACEHOLDER_CONTACT_EMAIL_DOMAIN,
        ].sort(),
      );
    });

    it("a contained address is NOT a placeholder", () => {
      expect(isPlaceholderContactEmail(toXeroSandboxContactEmail(REAL))).toBe(
        false,
      );
    });

    it("a placeholder is NOT a contained address, and is returned untransformed", () => {
      for (const domain of PLACEHOLDER_CONTACT_EMAIL_DOMAINS) {
        const placeholder = `something-1234@${domain}`;
        expect(isXeroSandboxContactEmail(placeholder)).toBe(false);
        expect(toXeroSandboxContactEmail(placeholder)).toBe(placeholder);
      }
    });
  });

  describe("the address this application would push to Xero", () => {
    it("is the address itself for a real one", () => {
      expect(xeroPushableContactEmail(" member@example.com ")).toBe(REAL);
    });

    it("is empty for a placeholder or a blank, matching what the payload builders send", () => {
      expect(
        xeroPushableContactEmail(`walk-in-x@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}`),
      ).toBe("");
      expect(xeroPushableContactEmail("")).toBe("");
      expect(xeroPushableContactEmail(null)).toBe("");
    });
  });

  describe("the containment fingerprint", () => {
    it("is the contained form of a real address", () => {
      expect(xeroSandboxContainmentTarget(REAL)).toBe(
        toXeroSandboxContactEmail(REAL),
      );
    });

    it("is empty for a walk-in placeholder owner, so the fast path is not missed", () => {
      // The regression this protects: fingerprinting the placeholder itself
      // while the create payload sends "" would mismatch on every invoice for a
      // walk-in owner and re-read their contact from Xero every single time.
      expect(
        xeroSandboxContainmentTarget(`walk-in-x@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}`),
      ).toBe("");
      expect(xeroSandboxContainmentTarget("")).toBe("");
    });

    it("is stable when handed the contained form instead of the source", () => {
      // `createXeroContactForMember` fingerprints the address it just SENT,
      // which is already contained. It has to land on the same value the funnel
      // derives from the member's stored address, or the two paths would
      // disagree about the same contact.
      expect(xeroSandboxContainmentTarget(toXeroSandboxContactEmail(REAL))).toBe(
        xeroSandboxContainmentTarget(REAL),
      );
    });

    it("moves when the member's address moves, which is what invalidates the proof", () => {
      expect(xeroSandboxContainmentTarget(REAL)).not.toBe(
        xeroSandboxContainmentTarget("moved@example.com"),
      );
    });
  });

  describe("whether Xero is holding something that can reach a member", () => {
    it("says no for blank, a placeholder, or a contained address", () => {
      expect(isXeroContactEmailUnreachable("")).toBe(true);
      expect(isXeroContactEmailUnreachable("   ")).toBe(true);
      expect(isXeroContactEmailUnreachable(null)).toBe(true);
      expect(isXeroContactEmailUnreachable(undefined)).toBe(true);
      for (const domain of PLACEHOLDER_CONTACT_EMAIL_DOMAINS) {
        expect(isXeroContactEmailUnreachable(`x-1@${domain}`)).toBe(true);
      }
      expect(
        isXeroContactEmailUnreachable(toXeroSandboxContactEmail(REAL)),
      ).toBe(true);
    });

    it("says YES for a real address, which is the direction that matters", () => {
      expect(isXeroContactEmailUnreachable(REAL)).toBe(false);
      expect(isXeroContactEmailUnreachable("someone@xero-sandbox.example")).toBe(
        false,
      );
    });
  });
});
