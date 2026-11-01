import { describe, expect, it } from "vitest";
import {
  emptyForm,
  formPayload,
  formRequestBody,
  formProblem,
  RATE_FIELD_NAMES,
  type OtherLodgeFormState,
} from "./other-lodge-form";

// The rate cells of the other-lodge editor (#61): typed dollars, parsed to
// cents by the exact parser (INV-MONEY-003), refused before a save when they
// would not parse — `formPayload` turns an unparseable rate into null, so the
// refusal in `formProblem` is what stops a typo silently clearing a rate.

function withRate(value: string): OtherLodgeFormState {
  return {
    ...emptyForm,
    name: "Tararua Lodge",
    rates: { ...emptyForm.rates, winterRateAdultCents: value },
  };
}

describe("other-lodge form: non-member rates", () => {
  it.each([
    ["45", 4500],
    ["45.5", 4550],
    ["45.50", 4550],
    ["0", 0],
    ["0.29", 29],
    ["99999.99", 9999999],
  ])("accepts %s as %i cents", (typed, cents) => {
    expect(formProblem(withRate(typed))).toBeNull();
    expect(formPayload(withRate(typed)).winterRateAdultCents).toBe(cents);
  });

  it("saves a blank rate as null, never as zero", () => {
    expect(formProblem(withRate("  "))).toBeNull();
    expect(formPayload(withRate("  ")).winterRateAdultCents).toBeNull();
  });

  it.each(["45.555", "-1", "abc", "4,5", "$45"])("refuses %s before saving", (typed) => {
    expect(formProblem(withRate(typed))).toBe(
      "Winter rate, Adult must be dollars and cents, for example 45 or 45.50.",
    );
  });

  it("refuses more than the central server holds", () => {
    expect(formProblem(withRate("100000"))).toBe(
      "Winter rate, Adult can be at most $99999.99.",
    );
  });

  it("sends every rate field, each null when blank", () => {
    const payload = formPayload({ ...emptyForm, name: "Tararua Lodge" });
    for (const field of RATE_FIELD_NAMES) expect(payload[field]).toBeNull();
  });
});

describe("other-lodge form: the booking page address (#55)", () => {
  const withSiteUrl = (siteUrl: string): OtherLodgeFormState => ({
    ...emptyForm,
    name: "Tararua Lodge",
    text: { ...emptyForm.text, siteUrl },
  });

  it.each(["", "https://tararua.test/book", "  http://tararua.test  "])("accepts %j", (value) => {
    expect(formProblem(withSiteUrl(value))).toBeNull();
  });

  it.each(["https://tararua.test@evil.test", "http:\\\\evil.test", "https://tararua.test/a b", "tararua.test"])(
    "refuses %j with the stricter rule's message",
    (value) => {
      expect(formProblem(withSiteUrl(value))).toMatch(/no spaces, no backslashes, and no @ before the site.s name/);
    },
  );
});

describe("other-lodge form: season start and end dates (#75)", () => {
  const withDates = (dates: Partial<OtherLodgeFormState["dates"]>): OtherLodgeFormState => ({
    ...emptyForm,
    name: "Tararua Lodge",
    dates: { ...emptyForm.dates, ...dates },
  });

  it("accepts seasons with a gap, and sends both end dates", () => {
    const form = withDates({
      winterSeasonStart: "2026-06-01",
      winterSeasonEnd: "2026-09-30",
      summerSeasonStart: "2026-12-01",
      summerSeasonEnd: "2027-03-31",
    });
    expect(formProblem(form)).toBeNull();
    expect(formPayload(form)).toMatchObject({ winterSeasonEnd: "2026-09-30", summerSeasonEnd: "2027-03-31" });
  });

  it("refuses overlapping seasons before any request", () => {
    expect(
      formProblem(withDates({ winterSeasonStart: "2026-06-01", winterSeasonEnd: "2026-12-15", summerSeasonStart: "2026-12-01" })),
    ).toMatch(/overlap: both include 1 December/);
  });
});


describe("other-lodge form: rates from the Fees page (#77)", () => {
  it("does not check rates or dates the Fees page fills, and sends the switch", () => {
    const form: OtherLodgeFormState = {
      ...withRate("not money"),
      dates: { ...emptyForm.dates, winterSeasonEnd: "2026-09-30" },
      ratesFromFees: true,
    };
    expect(formProblem(form)).toBeNull();
    expect(formPayload(form).ratesFromFees).toBe(true);
    // Off, the same form is refused as before.
    expect(formProblem({ ...form, ratesFromFees: false })).toMatch(/must be dollars and cents/);
  });

  it("sends no rates or dates while the switch is on, so a stale typed value cannot fail the save", () => {
    const form: OtherLodgeFormState = { ...withRate("150000"), ratesFromFees: true };
    const body = formRequestBody(form);
    expect(body).not.toHaveProperty("winterRateAdultCents");
    expect(body).not.toHaveProperty("summerSeasonEnd");
    expect(body).toMatchObject({ name: "Tararua Lodge", ratesFromFees: true });
    expect(formRequestBody({ ...form, ratesFromFees: false }).winterRateAdultCents).toBe(15_000_000);
  });

  it("sends no switch for a form that has none (another club's lodge)", () => {
    expect(formPayload(withRate("45"))).not.toHaveProperty("ratesFromFees");
  });
});
