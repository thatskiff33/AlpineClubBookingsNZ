import { describe, expect, it } from "vitest";
import { mapAddyAddressToSelection } from "@/lib/addy-address";

describe("mapAddyAddressToSelection", () => {
  it("maps a normal Addy NZ address into member address fields", () => {
    expect(
      mapAddyAddressToSelection({
        address1: "80 Queen Street",
        address2: "Auckland Central",
        city: "Auckland",
        displayline: "80 Queen Street",
        mailtown: "Auckland",
        postcode: "1010",
        region: "Auckland",
        suburb: "Auckland Central",
      }),
    ).toEqual({
      addressLine1: "80 Queen Street",
      addressLine2: "Auckland Central",
      city: "Auckland",
      region: "Auckland",
      postalCode: "1010",
      country: "NZ",
    });
  });

  it("preserves rural delivery address lines", () => {
    expect(
      mapAddyAddressToSelection({
        address1: "12 Alpine Road",
        address2: "RD 1",
        city: "Tokoroa",
        displayline: "12 Alpine Road",
        mailtown: "Tokoroa",
        postcode: "3491",
        region: "Waikato",
      }),
    ).toMatchObject({
      addressLine1: "12 Alpine Road",
      addressLine2: "RD 1",
      city: "Tokoroa",
      postalCode: "3491",
    });
  });
});
