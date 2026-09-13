import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/config/club-identity", () => ({
  CLUB_NAME: "Club <Name>",
  CLUB_PUBLIC_URL: "https://alpine.example.nz",
}));
vi.mock("@/config/operational", () => ({ APP_CURRENCY: "NZD", APP_STRIPE_CURRENCY: "nzd", APP_TIME_ZONE: "Pacific/Auckland", APP_LOCALE: "en-NZ" }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn(async () => 42),
  // The parameterised {{lodge-capacity:slug}} fallback path (multi-lodge).
  getDefaultLodgeCapacity: vi.fn(async () => 42),
}));
// {{facebook-url}} now resolves DB-first via getClubIdentity (C5 #1984), so the
// facebook link is surfaced through socialLinks.facebook, not the config constant.
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentity: vi.fn(async () => ({
    name: "Club <Name>",
    hutLeaderLabel: "Hut Leader",
    socialLinks: { facebook: "https://facebook.com/test-club?ref=a&b" },
  })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: vi.fn(async () => null) } },
}));

import {
  EMBED_TOKEN_REGEX,
  TEXT_TOKEN_REGEX,
  buildEmbeddedBody,
} from "@/lib/page-content-embeds";
import {
  HTML_TOKEN_CATALOGUE,
  embedTokenNames,
  legacySingleBraceTokenNames,
  textTokenNames,
  tokensForContext,
} from "@/lib/token-catalogue";

/** Counts matches without mutating the shared g-flagged regex state. */
function embedMatches(content: string): string[] {
  return Array.from(content.matchAll(EMBED_TOKEN_REGEX)).map(
    (match) => match[0],
  );
}

function textMatches(content: string): string[] {
  return Array.from(content.matchAll(TEXT_TOKEN_REGEX)).map(
    (match) => match[0],
  );
}

describe("token catalogue contents", () => {
  it("pins the embed token set", () => {
    expect(embedTokenNames()).toEqual([
      "committee-members-cards",
      "member-application-form",
      "contact-form",
      "join-apply-form",
      "booking-requests",
      "school-bookings",
      "skifield-conditions",
      "skifield-whakapapa",
      "photo-gallery",
      "photo-slideshow",
      "hut-fees",
      "joining-fees",
      "annual-fees",
      // Deprecated aliases (#1933, E7): render identically to their new names.
      "entrance-fees",
      "membership-types",
      "booking-policy-summary",
      "cancellation-policy",
    ]);
  });

  it("pins the text token set", () => {
    expect(textTokenNames()).toEqual([
      "club-name",
      "currency",
      "lodge-capacity",
      "lodge-name",
      "lodge-address",
      "hut-leader",
      "hut-leader-lower",
      "facebook-url",
    ]);
  });

  it("excludes photo tokens from the legacy single-brace form", () => {
    expect(legacySingleBraceTokenNames()).toEqual([
      "committee-members-cards",
      "member-application-form",
      "contact-form",
      "join-apply-form",
      "booking-requests",
      "school-bookings",
      "skifield-conditions",
      "skifield-whakapapa",
    ]);
  });

  it("gives every embed token the page-content-body context", () => {
    for (const definition of HTML_TOKEN_CATALOGUE) {
      if (definition.kind === "embed") {
        expect(definition.contexts).toContain("page-content-body");
      }
    }
  });

  it("limits the lodge-instructions context to text tokens", () => {
    const lodgeTokens = tokensForContext("lodge-instructions");
    expect(lodgeTokens.length).toBeGreaterThan(0);
    expect(lodgeTokens.every((token) => token.kind === "text")).toBe(true);
    expect(lodgeTokens.map((token) => token.token)).toEqual([
      "club-name",
      "currency",
      "lodge-capacity",
      "lodge-name",
      "lodge-address",
      "hut-leader",
      "hut-leader-lower",
    ]);
  });

  it("limits the site-footer context to text tokens", () => {
    const footerTokens = tokensForContext("site-footer");
    expect(footerTokens.length).toBeGreaterThan(0);
    expect(footerTokens.every((token) => token.kind === "text")).toBe(true);
    expect(footerTokens.map((token) => token.token)).toEqual([
      "club-name",
      "currency",
      "lodge-capacity",
      "lodge-name",
      "lodge-address",
      "facebook-url",
    ]);
  });

  it("lists every catalogue token except facebook-url in the page-content-body context", () => {
    expect(tokensForContext("page-content-body").map((t) => t.token)).toEqual(
      HTML_TOKEN_CATALOGUE.filter(
        (definition) => definition.token !== "facebook-url",
      ).map((definition) => definition.token),
    );
  });
});

describe("derived embed token regex (behaviour pin)", () => {
  it("matches every embed token in double braces", () => {
    for (const token of embedTokenNames()) {
      expect(embedMatches(`before {{${token}}} after`)).toEqual([
        `{{${token}}}`,
      ]);
    }
  });

  it("matches double-brace tokens with a parameter", () => {
    expect(
      embedMatches("{{skifield-conditions:4297a04af31a54b9b4dc710057f5a492}}"),
    ).toHaveLength(1);
    expect(
      embedMatches("{{photo-gallery:/public/images/photos/One}}"),
    ).toHaveLength(1);
    expect(
      embedMatches("{{photo-slideshow:/public/images/photos/One}}"),
    ).toHaveLength(1);
  });

  it("matches legacy single-brace form only for legacy-enabled tokens", () => {
    for (const token of legacySingleBraceTokenNames()) {
      expect(embedMatches(`{${token}}`)).toEqual([`{${token}}`]);
    }
  });

  it("does not match single-brace photo tokens", () => {
    expect(embedMatches("{photo-gallery}")).toEqual([]);
    expect(embedMatches("{photo-slideshow}")).toEqual([]);
    expect(embedMatches("{photo-gallery:/public/images/photos/One}")).toEqual(
      [],
    );
  });

  it("is case-insensitive", () => {
    expect(embedMatches("{{Contact-Form}}")).toHaveLength(1);
    expect(embedMatches("{CONTACT-FORM}")).toHaveLength(1);
    expect(embedMatches("{{PHOTO-GALLERY}}")).toHaveLength(1);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(embedMatches("{{ contact-form }}")).toHaveLength(1);
    expect(embedMatches("{{ skifield-conditions : zzz }}")).toHaveLength(1);
    expect(embedMatches("{ contact-form }")).toHaveLength(1);
  });

  it("does not match unknown tokens", () => {
    expect(embedMatches("{{not-a-token}}")).toEqual([]);
    expect(embedMatches("{not-a-token}")).toEqual([]);
  });
});

describe("derived text token regex (behaviour pin)", () => {
  it("matches every text token in double braces", () => {
    for (const token of textTokenNames()) {
      expect(textMatches(`{{${token}}}`)).toEqual([`{{${token}}}`]);
    }
  });

  it("is case-insensitive and whitespace tolerant", () => {
    expect(textMatches("{{ Club-Name }}")).toHaveLength(1);
    expect(textMatches("{{LODGE-CAPACITY}}")).toHaveLength(1);
  });

  it("never matches the single-brace form", () => {
    for (const token of textTokenNames()) {
      expect(textMatches(`{${token}}`)).toEqual([]);
    }
  });

  it("does not accept parameters on text tokens", () => {
    expect(textMatches("{{club-name:parameter}}")).toEqual([]);
  });
});

describe("buildEmbeddedBody with derived regexes", () => {
  it("still turns double-brace tokens into structured parts", async () => {
    const parts = await buildEmbeddedBody(
      "<p>Before</p>{{contact-form}}<p>After</p>",
    );
    expect(parts).toEqual([
      { type: "html", value: "<p>Before</p>" },
      { type: "contact-form" },
      { type: "html", value: "<p>After</p>" },
    ]);
  });

  it("still resolves text tokens with escaped values", async () => {
    const parts = await buildEmbeddedBody(
      "<p>{{club-name}} sleeps {{lodge-capacity}}.</p>",
    );
    expect(parts).toEqual([
      { type: "html", value: "<p>Club &lt;Name&gt; sleeps 42.</p>" },
    ]);
  });

  it("resolves facebook-url with an attribute-safe escaped value", async () => {
    const parts = await buildEmbeddedBody(
      '<p><a href="{{facebook-url}}">Facebook</a></p>',
    );
    expect(parts).toEqual([
      {
        type: "html",
        value:
          '<p><a href="https://facebook.com/test-club?ref=a&amp;b">Facebook</a></p>',
      },
    ]);
  });
});
