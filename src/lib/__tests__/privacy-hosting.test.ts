import { describe, expect, it } from "vitest";
import { privacyHostingSchema, dataHostingSentence } from "@/lib/privacy-hosting";
import { HTML_TOKEN_CATALOGUE, tokensForContext } from "@/lib/token-catalogue";
import { starterPageContent } from "../../../prisma/starter-page-content";

describe("privacy hosting disclosure", () => {
  it.each([
    [null, null, "A hosting company runs this System and its database. Ask our Privacy Officer which company this is and in which country your information is held."],
    ["Example Hosting", null, "Example Hosting hosts this System and its database. Ask our Privacy Officer in which country your information is held."],
    [null, "New Zealand", "The company that hosts this System and its database holds your information in New Zealand. Ask our Privacy Officer which company this is."],
    ["Example Hosting", "New Zealand", "Example Hosting hosts this System and its database; your information is held in New Zealand."],
  ])("builds the disclosure from %s / %s", (hostingProvider, dataLocation, expected) => {
    expect(dataHostingSentence({ hostingProvider, dataLocation })).toBe(expected);
  });
  it("trims and clears values", () => {
    expect(privacyHostingSchema.parse({ hostingProvider: "  Example  ", dataLocation: "  " })).toEqual({ hostingProvider: "Example", dataLocation: null });
  });
  it.each(["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u007fb", "a\u2028b", "a\u202Eb", "a\u2066b", "a".repeat(121), "\nExample"])("rejects multiline, control or overlong values", value => {
    expect(privacyHostingSchema.safeParse({ hostingProvider: value, dataLocation: null }).success).toBe(false);
  });
  it("limits the token to page bodies", () => {
    expect(HTML_TOKEN_CATALOGUE.find(t => t.token === "data-hosting")).toMatchObject({ kind: "text", contexts: ["page-content-body"] });
    expect(tokensForContext("site-footer").some(t => t.token === "data-hosting")).toBe(false);
    expect(tokensForContext("lodge-instructions").some(t => t.token === "data-hosting")).toBe(false);
  });
  it("keeps release 1 starter text free of the new token", () => {
    expect(JSON.stringify(starterPageContent)).not.toContain("{{data-hosting}}");
  });
});
