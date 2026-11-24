import { describe, expect, it } from "vitest";

import {
  assertValidClubPostContent,
  ClubPostValidationError,
  normalizeClubPostContent,
  serializeClubPostForMember,
} from "@/lib/club-posts";
import { MAX_CLUB_POST_LENGTH } from "@/lib/club-post-schema";

/**
 * #2994 (epic #2992) — the club message board's content rules and reader shape.
 *
 * The clock is frozen at 2026-07-01T00:00:00.000Z for every file, so fixtures
 * here are relative to that instant: 2026-08-01 is future, 2026-06-01 is past,
 * permanently.
 */

describe("club post content", () => {
  it("keeps the member's own line breaks", () => {
    expect(normalizeClubPostContent("one\ntwo")).toBe("one\ntwo");
  });

  it("normalises Windows and old-Mac line endings", () => {
    expect(normalizeClubPostContent("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("collapses a run of blank lines but keeps a paragraph break", () => {
    expect(normalizeClubPostContent("a\n\n\n\n\nb")).toBe("a\n\nb");
    expect(normalizeClubPostContent("a\n\nb")).toBe("a\n\nb");
  });

  it("strips control characters without touching tabs or newlines", () => {
    // NUL, a vertical tab and a DEL go; the tab and newline stay, because they
    // are how a member laid their own text out.
    const raw = "before\u0000after\u000Bmid\u007Fend\ttabbed\nnewline";
    expect(normalizeClubPostContent(raw)).toBe("beforeaftermidend\ttabbed\nnewline");
  });

  it("does NOT alter markup — it is stored as typed and escaped at render", () => {
    // Stripping here would silently rewrite a member's words. React escapes the
    // string on the way out, so what they typed is what they meant and what
    // they see.
    const raw = "<script>alert(1)</script> & <b>bold</b>";
    expect(normalizeClubPostContent(raw)).toBe(raw);
    expect(assertValidClubPostContent(raw)).toBe(raw);
  });

  it("refuses an empty or whitespace-only post", () => {
    for (const raw of ["", "   ", "\n\n\t"]) {
      expect(() => assertValidClubPostContent(raw)).toThrow(
        ClubPostValidationError,
      );
    }
  });

  it("refuses a non-string body", () => {
    for (const raw of [undefined, null, 42, { content: "x" }]) {
      expect(() => assertValidClubPostContent(raw)).toThrow(
        ClubPostValidationError,
      );
    }
  });

  it("accepts a post exactly at the limit", () => {
    const raw = "x".repeat(MAX_CLUB_POST_LENGTH);
    expect(assertValidClubPostContent(raw)).toHaveLength(MAX_CLUB_POST_LENGTH);
  });

  it("refuses one character over, and says by how much", () => {
    const raw = "x".repeat(MAX_CLUB_POST_LENGTH + 1);
    expect(() => assertValidClubPostContent(raw)).toThrow(
      new RegExp(String(MAX_CLUB_POST_LENGTH + 1)),
    );
  });

  it("measures AFTER normalising, so padding cannot buy length", () => {
    // A body that is over the limit only because of control characters is
    // accepted, because what gets stored is under it. The reverse — passing the
    // check and then storing something longer — is the case that must not
    // happen, and cannot, since both use the same normaliser.
    const raw = "x".repeat(MAX_CLUB_POST_LENGTH) + "\0".repeat(50);
    expect(assertValidClubPostContent(raw)).toHaveLength(MAX_CLUB_POST_LENGTH);
  });
});

describe("serializeClubPostForMember", () => {
  const base = {
    id: "post-1",
    authorName: "Jo Whitcombe",
    authorMemberId: "member-1",
    content: "Hut book is back at the lodge.",
    postedAt: new Date("2026-06-15T02:30:00.000Z"),
    originClubName: null as string | null,
  };

  it("marks the viewer's own post", () => {
    expect(serializeClubPostForMember(base, "member-1").mine).toBe(true);
    expect(serializeClubPostForMember(base, "member-2").mine).toBe(false);
  });

  it("does not mark a post whose author record is gone as anyone's", () => {
    // authorMemberId is SetNull when a member is removed, and null must not
    // accidentally match a viewer whose id is also somehow null-ish.
    const orphaned = { ...base, authorMemberId: null };
    expect(serializeClubPostForMember(orphaned, "member-1").mine).toBe(false);
    expect(serializeClubPostForMember(orphaned, "").mine).toBe(false);
  });

  it("keeps the author name snapshot rather than resolving a member", () => {
    // The name is stored on the row so the board still reads correctly after a
    // rename or a removal — and so a shared post carries a name the receiving
    // club can display without any way to resolve our member ids.
    const orphaned = { ...base, authorMemberId: null };
    expect(serializeClubPostForMember(orphaned, "member-2").authorName).toBe(
      "Jo Whitcombe",
    );
  });

  it("carries originClubName through for a future mirrored post", () => {
    const mirrored = { ...base, originClubName: "Tararua Alpine Club" };
    expect(serializeClubPostForMember(mirrored, "member-2").originClubName).toBe(
      "Tararua Alpine Club",
    );
    expect(serializeClubPostForMember(base, "member-2").originClubName).toBeNull();
  });

  it("serialises the timestamp as ISO", () => {
    expect(serializeClubPostForMember(base, "member-1").postedAt).toBe(
      "2026-06-15T02:30:00.000Z",
    );
  });
});
