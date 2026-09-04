// #2543 — the five booking write paths, read off the real source files.
//
// WHY STRUCTURAL AND NOT BEHAVIOURAL. Three of this issue's requirements cannot be
// observed from behaviour:
//
//   * "all five write paths enforce CONSISTENTLY" is a claim about a set of files.
//     A behavioural test of four of them passes just as green while the fifth
//     quietly keeps hard-blocking, and the fifth is the one a club notices;
//   * "the HARD_BLOCK refusal is mode-gated, but the member-guest LOOKUP still
//     runs" is a positional property. Moving the whole block behind the mode check
//     gives identical results under HARD_BLOCK and silently drops the D-8
//     cross-family privacy refusal under NON_MEMBER_PRICING;
//   * "the policy read happens before the transaction opens" gives the same answer
//     wherever it sits — it just holds the per-lodge capacity lock while doing it,
//     and `resolveSubscriptionLockoutMode` can reseed the financial-year cache
//     from Xero. A provider call under that lock is the one thing the booking
//     rules forbid outright.
//
// For those three, reading the source is not a shortcut; it is the only honest
// test. Mirrors the convention in member-guest-add-call-sites.test.ts.
//
// ENFORCES INV-LOCKOUT-026 (`docs/invariants/subscription-lockout-pricing.md`),
// which names this file: every write path passes the booking owner, counted
// against the evaluation calls file by file. That census repeats the id in its
// failure message, so whoever trips it is handed the rule rather than having to
// go and find it (#2691).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * Every non-test source file under `src/` that names `identifier`, as sorted
 * repo-relative POSIX paths.
 *
 * For assertions of the form "this wording belongs to exactly these paths". A
 * hand-listed set of files is not that assertion: it passes when a NEW site starts
 * using the thing, which is the only way the claim can ever be broken. Tests are
 * excluded because they legitimately name whatever they assert about.
 */
function sourceFilesNaming(identifier: string): string[] {
  const root = path.resolve(process.cwd(), "src");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      if (readFileSync(full, "utf8").includes(identifier)) {
        found.push(
          path.relative(process.cwd(), full).split(path.sep).join("/"),
        );
      }
    }
  };
  walk(root);
  return found.sort();
}

/** The five paths the issue names, and how each of them refuses. */
const WRITE_PATHS = [
  {
    name: "POST /api/bookings (create)",
    file: "src/app/api/bookings/route.ts",
  },
  {
    name: "POST /api/bookings/[id]/confirm-draft",
    file: "src/app/api/bookings/[id]/confirm-draft/route.ts",
  },
  {
    name: "POST /api/bookings/[id]/modify-quote",
    file: "src/app/api/bookings/[id]/modify-quote/route.ts",
  },
  {
    name: "POST /api/bookings/[id]/guests",
    file: "src/app/api/bookings/[id]/guests/route.ts",
  },
  {
    name: "group-booking join",
    file: "src/lib/group-booking.ts",
  },
] as const;

describe("every booking write path resolves the club's lockout mode (#2543)", () => {
  for (const site of WRITE_PATHS) {
    it(`${site.name} resolves the mode and evaluates the requirements`, () => {
      const source = readRepoFile(site.file);
      expect(source).toContain("resolveSubscriptionLockoutMode()");
      expect(source).toContain("evaluateNonMemberPricingRequirements(");
    });
  }

  it("resolves the mode exactly once per request on each path", () => {
    // Resolved once and passed down, so the HARD_BLOCK gate and the
    // paid-up-adult requirement cannot branch on different answers if an admin
    // saves the setting mid-request — which would refuse under one regime while
    // pricing under the other.
    for (const site of WRITE_PATHS) {
      const source = readRepoFile(site.file);
      const calls = source.match(/resolveSubscriptionLockoutMode\(\)/g) ?? [];
      expect(calls, site.name).toHaveLength(1);
    }
  });

  it("passes the resolved mode into the evaluation rather than letting it re-read", () => {
    for (const site of WRITE_PATHS) {
      const source = readRepoFile(site.file);
      const call = source.indexOf("evaluateNonMemberPricingRequirements(");
      // The `mode:` argument appears within the call's own argument object.
      const window = source.slice(call, call + 400);
      expect(window, site.name).toContain("mode: subscriptionLockoutMode");
    }
  });
});

describe("the HARD_BLOCK refusals are mode-gated, and only the refusals (#2543)", () => {
  it.each(WRITE_PATHS.map((site) => [site.name, site.file] as const))(
    "%s gates its subscription refusal on HARD_BLOCK",
    (_name, file) => {
      const source = readRepoFile(file);
      expect(source).toContain('subscriptionLockoutMode === "HARD_BLOCK"');
    },
  );

  it.each([
    ["POST /api/bookings (create)", "src/app/api/bookings/route.ts", "findUnpaidMemberGuests("],
    [
      "POST /api/bookings/[id]/modify-quote",
      "src/app/api/bookings/[id]/modify-quote/route.ts",
      "findUnpaidMemberGuestNames(",
    ],
    [
      "POST /api/bookings/[id]/guests",
      "src/app/api/bookings/[id]/guests/route.ts",
      "findUnpaidMemberGuestNames(",
    ],
    ["group-booking join", "src/lib/group-booking.ts", "findUnpaidMemberGuests("],
  ] as const)(
    "%s still RUNS the member-guest lookup under every mode",
    (name, file, lookup) => {
      // The lookup is what raises the D-8 neutral refusal for an unpaid member
      // guest from beyond the booker's family. That privacy boundary is not the
      // lockout policy's to relax — only the 403 below it is mode-gated.
      //
      // Two things are asserted, and both matter. First that the mode check sits
      // in the SAME condition as the unpaid-guest count, i.e. it gates the
      // refusal. Second that the lookup call precedes that condition, i.e. it is
      // not itself inside the gated block. Together those rule out the mistake:
      // wrapping the lookup AND the refusal in one `if (mode === HARD_BLOCK)`,
      // which behaves identically under HARD_BLOCK and silently drops the D-8
      // refusal under NON_MEMBER_PRICING.
      const source = readRepoFile(file);
      const lookupCall = source.indexOf(lookup);
      const refusalCondition = source.indexOf("unpaidMemberGuests.length > 0");

      expect(lookupCall, name).toBeGreaterThan(-1);
      expect(refusalCondition, name).toBeGreaterThan(-1);

      const condition = source.slice(
        Math.max(0, refusalCondition - 200),
        refusalCondition,
      );
      expect(condition, name).toContain(
        'subscriptionLockoutMode === "HARD_BLOCK"',
      );
      expect(lookupCall, name).toBeLessThan(refusalCondition);
    },
  );
});

describe("the payment path is DELIBERATELY ungated (#2779, INV-LOCKOUT-069)", () => {
  // Owner decision, 11 Aug 2026. #2779 was filed as an enforcement gap — under
  // HARD_BLOCK an unpaid member cannot confirm a FREE draft but can confirm a
  // PRICED one by paying for it — and the owner ruled that the asymmetry is the
  // feature: it is what lets an admin book on behalf of a locked-out member and
  // have that member sign in, pick the booking up and pay for it.
  //
  // STRUCTURAL, and it has to be. The claim is "no file in these two trees
  // refuses the booking owner over their subscription", which is a statement
  // about a SET OF FILES. A behavioural test of create-payment-intent passes
  // just as green while a later agent, reading this issue's original framing,
  // adds the gate to charge-saved-method instead — and the member it silently
  // strands is the one who was told to log in and pay.
  // CALL shapes, not bare identifiers — every entry carries its opening paren or
  // its property key. That is deliberate: the whole point of this issue is that
  // the absence is documented, so a comment in a payment route explaining why
  // there is no `SUBSCRIPTION_REQUIRED` refusal here must not trip the guard that
  // protects it. What is forbidden is CALLING the resolver or ANSWERING with the
  // refusal, and neither can be done without these exact strings.
  const LOCKOUT_IDENTIFIERS = [
    "resolveSubscriptionLockoutMode(",
    "peekSubscriptionLockoutMode(",
    "peekSubscriptionLockoutModeStrict(",
    "requiresPaidSubscriptionForMemberForBooking(",
    "requiresPaidSubscriptionForBooking(",
    'code: "SUBSCRIPTION_REQUIRED"',
  ] as const;

  const UNGATED_TREES = [
    "src/app/api/payments/",
    "src/app/api/webhooks/",
  ] as const;

  // The route trees ALONE are close to vacuous, and measurement said so. The
  // Stripe webhook route is ~100 lines of signature verification that delegates
  // to `stripe-webhook-service.ts`, and the pay route delegates its settlement to
  // the credit/reconciliation modules — so injecting a real
  // `resolveSubscriptionLockoutMode()` call into `payment-reconciliation.ts`
  // (which owns `markBookingPaymentSucceeded`, the function that actually
  // confirms a paid booking) left the tree-only census GREEN while the same
  // injection into a payments ROUTE turned it red. An agent reading #2779's
  // original framing would have added the gate exactly there.
  //
  // Listed EXPLICITLY rather than derived from the routes' transitive `@/lib`
  // imports, and the difference matters: the transitive closure of
  // `create-payment-intent` reaches pricing and booking-policy modules that
  // legitimately DO carry the gate (`membership-type-policy.ts`,
  // `booking-policy-exceptions.ts`, `waitlist.ts` …), so a closure-based census
  // would forbid the rule where the rule belongs. What is forbidden is the gate
  // on the modules that CLAIM or SETTLE a payment for the booking's owner.
  //
  // `booking-error-payment-targets.ts` is deliberately NOT here despite its name:
  // it maps refusal reasons (SUBSCRIPTION_REQUIRED among them) onto UI targets,
  // and reporting a refusal some other path already raised is not raising one.
  const UNGATED_SETTLEMENT_MODULES = [
    // Stripe webhook confirmation — the route is a shim, this is the logic.
    "src/lib/stripe-webhook-service.ts",
    // markBookingPaymentSucceeded: the PAID claim itself.
    "src/lib/payment-reconciliation.ts",
    // settleFullyCreditCoveredBooking: the $0/credit-covered PAID claim.
    "src/lib/booking-credit-election.ts",
    // canCreateImmediatePaymentIntent: whether the owner may pay at all.
    "src/lib/booking-payment-flow.ts",
    // Payment row writes shared by every settle path.
    "src/lib/payment-transactions.ts",
    // The emailed pay-by-link door onto the same journey (#2956 split it by
    // responsibility; every piece stays listed so the door is still covered).
    "src/lib/payment-link.ts",
    "src/lib/payment-link-intent.ts",
    "src/lib/payment-link-split-guest.ts",
  ] as const;

  it.each(UNGATED_SETTLEMENT_MODULES)(
    "%s still exists, so the census below is not silently empty",
    (file) => {
      // A census that names a file by string goes quiet the day the file is
      // renamed. Fail loudly instead, and make whoever moved it re-point the list.
      expect(() => readRepoFile(file)).not.toThrow();
    },
  );

  it.each(LOCKOUT_IDENTIFIERS)(
    "no payment route, webhook route or settlement module names %s",
    (identifier) => {
      const offenders = sourceFilesNaming(identifier).filter(
        (file) =>
          UNGATED_TREES.some((tree) => file.startsWith(tree)) ||
          (UNGATED_SETTLEMENT_MODULES as readonly string[]).includes(file),
      );
      expect(
        offenders,
        `INV-LOCKOUT-069 (#2779): the payment path carries no subscription gate ` +
          `on purpose — it is the only way a subscription-locked member can pay ` +
          `for a booking an admin made on their behalf. ${identifier} appeared ` +
          `in: ${offenders.join(", ")}. That covers the payment/webhook route ` +
          `trees AND the modules those routes delegate settlement to, because a ` +
          `gate one layer down strands exactly the same member. If the club ` +
          `really does want to refuse payment while a subscription is owed, that ` +
          `is an owner decision and a new issue, not a fix here.`,
      ).toEqual([]);
    },
  );

  it("confirm-draft's subscription refusal can only ever bite a ZERO-price draft", () => {
    // The narrowness is positional and invisible from behaviour: the 400 for a
    // priced draft is returned BEFORE the subscription gate is reached, so a
    // priced draft never meets it. Move the gate above that check and a
    // locked-out member is refused on the very door #2779 exists to keep open,
    // with every service-level test still green.
    const source = readRepoFile(
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
    );
    const pricedDraftRefusal = source.indexOf(
      "Use the payment flow to complete non-zero bookings",
    );
    const subscriptionGate = source.indexOf(
      'subscriptionLockoutMode === "HARD_BLOCK"',
    );

    expect(pricedDraftRefusal).toBeGreaterThan(-1);
    expect(subscriptionGate).toBeGreaterThan(-1);
    expect(
      pricedDraftRefusal,
      "INV-LOCKOUT-069 (#2779): the priced-draft hand-off must stay ABOVE the " +
        "HARD_BLOCK refusal, so the refusal only reaches a $0 draft.",
    ).toBeLessThan(subscriptionGate);
  });

  it("the booking-create HARD_BLOCK gate still exempts an authorised on-behalf create", () => {
    // The other half of the journey: without this term the admin could not make
    // the booking in the first place, and nothing downstream would matter.
    const source = readRepoFile("src/app/api/bookings/route.ts");
    const gate = source.indexOf('subscriptionLockoutMode === "HARD_BLOCK"');
    expect(gate).toBeGreaterThan(-1);
    expect(
      source.slice(gate, gate + 200),
      "INV-LOCKOUT-069 (#2779): an admin must be able to book on behalf of a " +
        "subscription-locked member.",
    ).toContain("!isAuthorizedOnBehalf");
  });
});

describe("INV-LOCKOUT-070's zero-price bullet states what is true (#2779)", () => {
  // The bullet FIRST shipped saying a $0 draft "cannot be picked up by a
  // locked-out member … the only door is confirm-draft". That was false, and an
  // invariant that is false is worse than no invariant: this one told the next
  // agent that a door which is open does not exist, and forbade closing it.
  //
  // What is actually true is narrower and worth writing down precisely. There is
  // no member-facing CONTROL for a $0 draft — the booking page gates its payment
  // card on `finalPriceCents > 0` — but `POST /api/payments/create-payment-intent`
  // admits a DRAFT with no price precondition and decides the zero case inside
  // its own transaction, settling PAYMENT_PENDING -> PAID through
  // `settleFullyCreditCoveredBooking`. A member calling that route directly does
  // confirm a $0 draft, locked out or not.
  //
  // That is ACCEPTED (it follows from INV-LOCKOUT-069, and no money moves), not
  // absent. These two assertions are a pair on purpose: the first stops the
  // false sentence coming back, the second fails the day the route's zero-dollar
  // branch is removed or renamed — at which point the invariant is describing a
  // branch that no longer exists and must be rewritten again.
  const INVARIANT_DOC = "docs/invariants/subscription-lockout-pricing.md";
  const PAY_ROUTE = "src/app/api/payments/create-payment-intent/route.ts";

  it("does not claim a $0 draft cannot be settled at all", () => {
    const doc = readRepoFile(INVARIANT_DOC);

    expect(
      doc,
      "INV-LOCKOUT-070 (#2779): the pay route's zero-dollar settle branch is a " +
        "second, ungated door onto a $0 draft. Do not restore the claim that " +
        "confirm-draft is the only one.",
    ).not.toContain("A $0 on-behalf draft cannot be picked up");
    expect(doc).toContain("create-payment-intent");
    expect(doc).toContain("settleFullyCreditCoveredBooking");
  });

  it("and the pay route branch the invariant describes still exists", () => {
    const route = readRepoFile(PAY_ROUTE);

    // DRAFT is admitted, with no price precondition anywhere above the
    // transaction — the `effectivePriceCents <= 0` refusal sits BELOW it and is
    // only reached when the zero case was not already settled.
    expect(route).toContain('booking.status !== "DRAFT"');
    expect(route).toContain("settledEffectivePriceCents <= 0");
    expect(
      route,
      "INV-LOCKOUT-070 (#2779) describes this branch by name. If it has moved, " +
        "rewrite the invariant rather than deleting this assertion.",
    ).toContain("settleFullyCreditCoveredBooking(tx, {");
  });
});

describe("no lockout policy read inside a booking transaction (#2543)", () => {
  const TRANSACTIONAL_SITES = [
    {
      name: "api/bookings/[id]/guests/route.ts",
      file: "src/app/api/bookings/[id]/guests/route.ts",
      transactionMarker: "await prisma.$transaction(",
    },
  ] as const;

  for (const site of TRANSACTIONAL_SITES) {
    it(`${site.name} resolves the mode before it opens its transaction`, () => {
      const source = readRepoFile(site.file);
      const modeRead = source.indexOf("await resolveSubscriptionLockoutMode()");
      const transaction = source.indexOf(site.transactionMarker);

      expect(modeRead).toBeGreaterThan(-1);
      expect(transaction).toBeGreaterThan(-1);
      expect(modeRead).toBeLessThan(transaction);
    });

    it(`${site.name} applies D-12 presence to the rows the add is about to create`, () => {
      // A cross-family member guest is added PENDING. Without this the rule would
      // be trivially satisfiable: add any paid-up adult member as a guest, and the
      // invite need never be accepted.
      //
      // The mapping is no longer inline. `toSubscriptionLockoutParticipants` reads a
      // persisted row's `consentStatus` AND a pre-persist row's planned
      // `memberGuestConsent.consentStatus`, which is exactly the two shapes this
      // route holds, so both lists go through the one helper. That matters more
      // than the inline form did: the helper originally read a field name that does
      // not exist in the schema, every persisted row answered `undefined`, and the
      // guard was inert while its own unit test stayed green. Asserting the helper
      // is what is called keeps the two shapes on one code path.
      const source = readRepoFile(site.file);
      const call = source.indexOf("evaluateNonMemberPricingRequirements(tx, {");
      const window = source.slice(call, call + 1600);
      expect(window).toContain("toSubscriptionLockoutParticipants([");
      expect(window).toContain("...booking.guests");
      expect(window).toContain("...normalizedNewGuests");
    });

    it(`${site.name} passes the transaction client to the in-transaction evaluation`, () => {
      // Inside the transaction the evaluation must read through `tx`, so its
      // queries participate in the advisory lock rather than racing it on a second
      // connection.
      const source = readRepoFile(site.file);
      const transaction = source.indexOf(site.transactionMarker);
      const inTransaction = source.slice(transaction);
      expect(inTransaction).toContain(
        "evaluateNonMemberPricingRequirements(tx, {",
      );
    });
  }

  it("the pricing gate uses the peek reader, which cannot reach Xero", () => {
    // `resolveGuestRateMembershipTypes` runs inside booking transactions that hold
    // the per-lodge capacity lock. `resolveSubscriptionLockoutMode` reseeds the
    // financial-year cache and can therefore reach Xero for the organisation's
    // accounting year; `peekSubscriptionLockoutMode` cannot. The pricing gate must
    // use the latter, and nothing but the latter.
    const source = readRepoFile("src/lib/membership-type-policy.ts");
    expect(source).toContain("peekSubscriptionLockoutMode()");
    expect(source).not.toContain("resolveSubscriptionLockoutMode");
    // ...and the peek is only the FALLBACK: a caller that already resolved the mode
    // passes it, so the in-transaction gate takes no second pool connection at all.
    expect(source).toContain(
      "params.subscriptionLockoutMode ?? (await peekSubscriptionLockoutMode())",
    );
  });

  it("the exception-request re-evaluation reads through its own client", () => {
    // The override door: a member refused by a booking path re-submits the party
    // here, and this re-evaluation is what reproduces the violation server-side.
    const source = readRepoFile("src/lib/booking-exception-request-service.ts");
    expect(source).toContain("evaluateProposedPaidUpAdultPresence(db, {");
  });

  it("the exception-request re-evaluation carries D-12 presence, so the door opens", () => {
    // Without it, the PENDING cross-family adult a booking path correctly excluded
    // reads as present here, no violation is found, and the request machinery
    // refuses to create a request there is nothing to review — the 409 names a
    // workflow the member cannot enter. `ProposalGuest` deliberately does NOT carry
    // the fact (the proposal is frozen and hashed), so it is derived.
    const source = readRepoFile("src/lib/booking-exception-request-service.ts");
    expect(source).toContain("resolveProposalOperationalPresence(");
    expect(source).toContain("operationallyPresent: operationallyPresentFor(");
    // A new booking has no live rows, so every cross-family member guest is
    // somebody who WOULD be invited PENDING; a modification also consults the
    // stored consent status of the rows already on the booking, so a CONFIRMED
    // cross-family adult is not wrongly excluded.
    expect(source).toContain("{ requestedByMemberId: input.requestedByMemberId }");
    expect(source).toContain("bookingId: input.bookingId,");
    expect(source).toContain("computeMemberGuestBoundary(");
    expect(source).toContain("isOperationallyPresentConsent(row.consentStatus)");
  });
});

describe("the refusal body is built in one place (#2543)", () => {
  it.each(WRITE_PATHS.map((site) => [site.name, site.file] as const))(
    "%s builds its refusal from the shared helper",
    (name, file) => {
      // Five paths describing the same refusal five ways is how a member ends up
      // told they may ask a Booking Officer on four screens and not on the fifth.
      const source = readRepoFile(file);
      expect(source, name).toContain("buildPaidUpAdultRefusalBody(");
    },
  );

  it("the guests route tests its own error subclass before the shared ApiError branch", () => {
    // PaidUpAdultMemberRequiredError extends ApiError. Handled in the wrong order,
    // the generic branch flattens it to a bare sentence and closes the exception
    // door the refusal promises.
    const source = readRepoFile("src/app/api/bookings/[id]/guests/route.ts");
    const subclass = source.indexOf("err instanceof PaidUpAdultMemberRequiredError");
    const shared = source.indexOf("err instanceof SharedApiError");

    expect(subclass).toBeGreaterThan(-1);
    if (shared > -1) {
      expect(subclass).toBeLessThan(shared);
    }
  });
});

describe("the sixth refusal site, and the paths that were missing (#2543)", () => {
  it("the modify APPLY path mode-gates its unpaid-member-guest refusal", () => {
    // `prepareGuestPlan` is the apply half of the edit flow whose preview is
    // modify-quote. Ungated it hard-blocked in every regime, so a member was quoted
    // the non-member price with an explanation and then refused on save with the
    // pre-#2543 403 — an edit that could never complete.
    const source = readRepoFile("src/lib/booking-modify-plan.ts");
    const lookup = source.indexOf("findUnpaidMemberGuestNames(tx, {");
    const refusal = source.indexOf(
      "All member guests must have a paid subscription before booking",
    );
    const gate = source.indexOf(
      '(subscriptionLockoutMode ?? "HARD_BLOCK") === "HARD_BLOCK"',
    );

    expect(lookup).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    // The lookup still runs in every mode: it is what raises the D-8 neutral
    // refusal for a beyond-family unpaid member guest, and that privacy boundary is
    // not the lockout policy's to relax. Only the refusal is gated.
    expect(lookup).toBeLessThan(gate);
    expect(gate).toBeLessThan(refusal);
  });

  it("the modify APPLY path evaluates the paid-up-adult requirement itself", () => {
    // Two holes: `PUT /api/bookings/[id]/modify` is reachable without ever calling
    // modify-quote, and the requirement was evaluated on ADDITIVE writes only, so
    // `removeGuestIds` could take the party's last paid-up adult member off a
    // booking the add path had just approved on the strength of their presence.
    const source = readRepoFile("src/lib/booking-modify-plan.ts");
    expect(source).toContain("evaluateNonMemberPricingRequirements(tx, {");
    expect(source).toContain("new PaidUpAdultMemberRequiredError(");
    // Over the PROPOSED party, which is what covers adds, removals and date
    // changes in one place instead of one gate per request shape.
    expect(source).toContain("participants: guestsForPricing.map(");
  });

  it("single-guest removal re-evaluates the requirement over what is left", () => {
    const source = readRepoFile("src/lib/booking-guest-removal-service.ts");
    expect(source).toContain("evaluateNonMemberPricingRequirements(tx, {");
    expect(source).toContain(
      "toSubscriptionLockoutParticipants(remainingGuests)",
    );
    // A consent DECLINE or EXPIRY is exempt — D-14 requires that a member who has
    // declined can always be taken off — and an ADMIN is skipped as everywhere else.
    expect(source).toContain('actorRole !== "ADMIN" && !consentAuthority');
  });

  it("the removal route answers the refusal with the shared body, before the generic ApiError branch", () => {
    const source = readRepoFile(
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    );
    const subclass = source.indexOf(
      "err instanceof PaidUpAdultMemberRequiredError",
    );
    const generic = source.indexOf("err instanceof ApiError");
    expect(subclass).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(-1);
    expect(subclass).toBeLessThan(generic);
    // Audience-branched, because this is the one refusal that can be delivered to
    // somebody who does not own the booking (self-removal from another member's
    // booking), where `repricedUnpaidMemberCount: 0` would expose the OWNER's unpaid
    // subscription. The service decides, since only it still holds the booking row.
    expect(source).toContain('err.audience === "OTHER_PARTY_MEMBER"');
    expect(source).toContain(
      "buildPaidUpAdultRefusalBodyForOtherPartyMember(err.violation)",
    );
    expect(source).toContain("buildPaidUpAdultRefusalBody(err.violation)");
  });

  it("the removal service asks for the narrowed audience when the actor is not the owner", () => {
    const source = readRepoFile("src/lib/booking-guest-removal-service.ts");
    expect(source).toContain(
      'booking.memberId === actorMemberId ? "BOOKER" : "OTHER_PARTY_MEMBER"',
    );
    // And it is the ONLY site that asks for it: every other gate runs for the
    // unfinancial member themselves (or for an admin, who is exempt), so narrowing
    // there would withhold a count from the one person it is already about.
    const askers = sourceFilesNaming("OTHER_PARTY_MEMBER").filter(
      // The module that declares the audience type and implements the narrowing.
      (file) => file !== "src/lib/subscription-lockout-enforcement.ts",
    );
    expect(askers).toEqual([
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/lib/booking-guest-removal-service.ts",
    ]);
    // And the narrowed builder is called from that route and nowhere else, so no
    // other path can quietly start withholding a count from the person it is about.
    expect(
      sourceFilesNaming("buildPaidUpAdultRefusalBodyForOtherPartyMember").filter(
        (file) => file !== "src/lib/subscription-lockout-enforcement.ts",
      ),
    ).toEqual(["src/app/api/bookings/[id]/guests/[guestId]/route.ts"]);
  });

  it("the modify route answers the refusal with the shared body, before the generic ApiError branch", () => {
    const source = readRepoFile("src/app/api/bookings/[id]/modify/route.ts");
    const subclass = source.indexOf(
      "err instanceof PaidUpAdultMemberRequiredError",
    );
    const generic = source.indexOf("err instanceof ApiError");
    expect(subclass).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(-1);
    expect(subclass).toBeLessThan(generic);
  });

  it("the waitlist re-checks the requirement, outside the claiming transaction", () => {
    // The sweep reprices a STORED booking's money and passes no locked night
    // prices, so the whole stay re-bases. Both halves of the owner's rule now reach
    // it: the refusal, and the explanation on the offer.
    const source = readRepoFile("src/lib/waitlist.ts");
    const check = source.indexOf("evaluateNonMemberPricingRequirements(prisma, {");
    const transaction = source.indexOf("result = await prisma.$transaction(");
    expect(check).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(-1);
    expect(check).toBeLessThan(transaction);
    // Fails closed WITHOUT consuming the offer, exactly as the minimum-stay check
    // beside it does, so the member keeps their place.
    expect(source).toContain("revertSameLodgeOfferToWaitlisted(bookingId, offerLodgeId, {");
    expect(source).toContain('code: "PAID_UP_ADULT_MEMBER_REQUIRED"');
    expect(source).toContain("paidUpAdultRefusal: buildPaidUpAdultRefusalBody(");
  });

  it("the group-join refusal carries the path to the override door", () => {
    // The other four paths return `exceptionRequestPath`; this one destructured
    // everything except it, so a client written against the shared body rendered no
    // "ask a Booking Officer" link on this path alone.
    const lib = readRepoFile("src/lib/group-booking.ts");
    expect(lib).toContain("exceptionRequestPath: refusal.exceptionRequestPath");
    const route = readRepoFile("src/app/api/group-bookings/[code]/join/route.ts");
    expect(route).toContain("exceptionRequestPath: err.exceptionRequestPath");
  });
});

describe("the booking OWNER reaches every evaluation (#2543, owner decision 3 Aug 2026)", () => {
  function paidUpEvaluationCalls(source: string): string[] {
    return (
      source.match(
        /evaluateNonMemberPricingRequirements\([\s\S]*?\n\s*\}\);/g,
      ) ?? []
    );
  }

  // The paid-up-adult requirement now fires when the booking OWNER is an
  // unfinancial member, whether or not they stay. That is a property of a SET of
  // call sites, not of behaviour: a path that forgets to pass the owner still
  // enforces the old repriced-only rule and every behavioural test of the other
  // paths stays green, while the one path a lapsed member reaches to book beds for
  // non-members goes on letting them through. So the owner argument is counted
  // against the calls, file by file, and a NEW call site added without it fails
  // here rather than shipping a hole.
  const EVALUATION_SITES = [
    ["POST /api/bookings (create)", "src/app/api/bookings/route.ts", "effectiveMemberId"],
    [
      "POST /api/bookings/quote (preview)",
      "src/app/api/bookings/quote/route.ts",
      "effectiveMemberId",
    ],
    [
      "POST /api/bookings/[id]/confirm-draft",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "booking.memberId",
    ],
    [
      "POST /api/bookings/[id]/modify-quote",
      "src/app/api/bookings/[id]/modify-quote/route.ts",
      "booking.memberId",
    ],
    [
      "POST /api/bookings/[id]/guests",
      "src/app/api/bookings/[id]/guests/route.ts",
      "booking.memberId",
    ],
    ["the modify APPLY path", "src/lib/booking-modify-plan.ts", "booking.memberId"],
    [
      "single-guest removal",
      "src/lib/booking-guest-removal-service.ts",
      "booking.memberId",
    ],
    ["group-booking join", "src/lib/group-booking.ts", "sessionUserId"],
  ] as const;

  it.each(EVALUATION_SITES)(
    "%s passes the booking owner it already holds",
    (name, file, ownerExpression) => {
      const source = readRepoFile(file);
      const calls = paidUpEvaluationCalls(source);
      // Named in every failure so the rule arrives with the symptom, not after
      // a search for it (#2691).
      const why =
        `INV-LOCKOUT-026 (docs/invariants/subscription-lockout-pricing.md): ${name}`;

      expect(calls.length, why).toBeGreaterThan(0);
      expect(
        calls.every((call) => call.includes("bookingOwnerMemberId:")),
        why,
      ).toBe(true);
      expect(calls, why).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`bookingOwnerMemberId: ${ownerExpression}`),
        ]),
      );
    },
  );

  it("the waitlist passes the owner on BOTH its evaluations", () => {
    // The confirm is where the refusal lives; the offer reads only the rate notice
    // and is threaded so the two cannot drift.
    const source = readRepoFile("src/lib/waitlist.ts");
    const calls = paidUpEvaluationCalls(source);

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.includes("bookingOwnerMemberId:"))).toBe(
      true,
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("bookingOwnerMemberId: offerKind.memberId"),
        expect.stringContaining("bookingOwnerMemberId: offerDetails.memberId"),
      ]),
    );
  });

  it("the cross-lodge promotion passes the owner too", () => {
    // The seventh money path, and the one that reached NONE of the rule: it calls
    // `createConfirmedBooking` directly, so the create route's gate never ran, while
    // the offer sweep had already re-based the stored price and inherited the
    // reprice. `confirmWaitlistOffer` had the same defect and was fixed; leaving its
    // cross-lodge twin unfixed would mean the answer depended on which lodge the
    // sweep happened to offer.
    const source = readRepoFile("src/lib/waitlist-cross-lodge.ts");
    const calls = paidUpEvaluationCalls(source);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(
      "bookingOwnerMemberId: preflight.memberId",
    );
  });

  it("the exception-request re-evaluation resolves the owner server-side, so the widened door opens", () => {
    // A refusal that keys on the booker must reproduce here, or the 409 names a
    // workflow the member cannot enter. A MODIFICATION reads the LIVE booking's own
    // `memberId` rather than trusting the requester to be it — the door must not be
    // openable against somebody else's standing — and a NEW booking has no row yet,
    // so the requester is who would own it.
    const source = readRepoFile("src/lib/booking-exception-request-service.ts");
    expect(source).toContain(
      "const bookingOwnerMemberId = resolveProposalBookingOwner(",
    );
    expect(source).toMatch(
      /evaluateProposedAdultMemberHosting\([\s\S]*?bookingOwnerMemberId,/,
    );
    expect(source).toMatch(
      /evaluateProposedPaidUpAdultPresence\([\s\S]*?bookingOwnerMemberId,/,
    );
    expect(source).toContain("function resolveProposalBookingOwner(");
    // #3038 folded the owner read together with the Group Trip read: both ask
    // about the SAME live row, and both used to `findUnique` it separately. The
    // property this test cares about is unchanged and is still asserted — the
    // owner comes from the LIVE booking's own `memberId`, server-side — it is
    // now carried on one select constant instead of an inline one.
    expect(source).toContain("await loadProposalBooking(db, presence)");
    expect(source).toMatch(
      /const PROPOSAL_BOOKING_SELECT = \{[\s\S]*?memberId: true,/,
    );
    expect(source).toContain("select: PROPOSAL_BOOKING_SELECT,");
    expect(source).toContain("return booking?.memberId ?? null;");
    expect(source).toContain("return presence?.requestedByMemberId?.trim() || null;");
  });

  it("the two waitlist paths refuse with one shared sentence, and the booking paths do not", () => {
    // Both waitlist paths reject the offer WITHOUT consuming it, so their refusal
    // has to say so — the bare sentence read as though the member had lost the offer
    // AND their spot. Shared through ONE formatter rather than copied, so the answer
    // cannot depend on which lodge the sweep happened to offer; and scoped to those
    // two, because a booking-time refusal has no waitlist place to claim.
    for (const file of ["src/lib/waitlist.ts", "src/lib/waitlist-cross-lodge.ts"]) {
      const source = readRepoFile(file);
      expect(source, file).toContain(
        "error: formatMissingPaidUpAdultWaitlistRefusal(),",
      );
      // Not the frozen violation's message, which the officer's snapshot keeps.
      expect(source, file).not.toContain("error: nonMemberPricing.violation.message");
    }
    // The negative half is a TREE-WIDE sweep, not a hand-listed set of files.
    // Listing four of them was the bug: it omitted `.../guests/route.ts` — the
    // fifth entry of this file's own WRITE_PATHS — and every other refusal site
    // tested elsewhere in this suite (the modify apply path, the removal service
    // and its route, the modify route, the exception-request service). A later lane
    // wiring the refusal through one of those would reach for this formatter (it is
    // the nicer-reading sentence) and tell a member "You've kept your place on the
    // waitlist" on a refusal with no waitlist entry behind it, and the suite would
    // have stayed green. Enumerating the tree cannot go stale as sites are added.
    const callers = sourceFilesNaming(
      "formatMissingPaidUpAdultWaitlistRefusal",
    ).filter(
      // The module that DEFINES and exports it, which necessarily names it.
      (file) => file !== "src/lib/policies/subscription-lockout-pricing.ts",
    );
    expect(callers).toEqual([
      "src/lib/waitlist-cross-lodge.ts",
      "src/lib/waitlist.ts",
    ]);
  });

  it("every waitlist-confirm SUCCESS branch carries the rate notice, cross-lodge included", () => {
    // The route has three success returns — cross-lodge promotion, the $0
    // auto-PAID flip, and the ordinary confirm — and the cross-lodge one silently
    // dropped the notice while the service computed it and DOMAIN_INVARIANTS said it
    // rode the result. That branch is the one that earns it: a cross-lodge quote can
    // differ from the member's own lodge by the whole member/non-member spread.
    // Structural because all three build a plain object literal; a behavioural test
    // of two of them passes just as green.
    const source = readRepoFile(
      "src/app/api/bookings/[id]/waitlist-confirm/route.ts",
    );
    const successReturns = source.split("success: true,").length - 1;
    const notices =
      source.split(
        "subscriptionMemberRateNotice: result.subscriptionMemberRateNotice ?? null,",
      ).length - 1;

    expect(successReturns).toBe(3);
    expect(notices).toBe(successReturns);
  });

  it("the waitlist-confirm route lets the path's own sentence win over the shared body", () => {
    // Positional, and it silently ate the wording once already:
    // `buildPaidUpAdultRefusalBody` carries its own `error` (the frozen violation's
    // message), so spreading the body AFTER `error: result.error` discarded the
    // waitlist sentence while every service-level test stayed green.
    const source = readRepoFile(
      "src/app/api/bookings/[id]/waitlist-confirm/route.ts",
    );
    const spread = source.indexOf("...(result.paidUpAdultRefusal ?? {}),");
    const error = source.indexOf("error: result.error,");

    expect(spread).toBeGreaterThan(-1);
    expect(error).toBeGreaterThan(-1);
    expect(spread).toBeLessThan(error);
  });

  it("keeps the reprice list a statement about the party, not about the owner", () => {
    // The owner joins the FACTS batch only. Counting a not-staying owner as
    // repriced would inflate the violation's count and emit a rate notice about a
    // charge nobody received.
    const source = readRepoFile("src/lib/subscription-lockout-enforcement.ts");
    expect(source).toContain("const repricedMemberIds = partyMemberIds");
    expect(source).toContain("memberIds: settlementMemberIds,");
    expect(source).toContain("where: { id: { in: partyMemberIds } }");
    // And the notice follows the reprice, not the requirement, now that the two
    // are different questions.
    expect(source).toContain("repricedMemberIds.length > 0\n        ? formatUnpaidSubscriptionRateReason(");
  });
});

describe("the mode is threaded to the money, not re-read inside the locks (#2543)", () => {
  const THREADED = [
    ["src/lib/booking-create.ts", "input.subscriptionLockoutMode", 3],
    ["src/lib/booking-modify-plan.ts", "subscriptionLockoutMode,", 4],
    ["src/app/api/bookings/[id]/modify-quote/route.ts", "subscriptionLockoutMode,", 7],
    ["src/lib/waitlist.ts", "subscriptionLockoutMode,", 2],
  ] as const;

  it.each(THREADED)(
    "%s hands the resolved mode to every pricing call",
    (file, marker, atLeast) => {
      const source = readRepoFile(file);
      const occurrences = source.split(marker).length - 1;
      expect(occurrences, `${file} — ${marker}`).toBeGreaterThanOrEqual(atLeast);
    },
  );

  /*
    THE POSITIONAL ASSERTION THAT USED TO SIT HERE IS GONE (#3232 fix round), and
    deleting it is the fix rather than a loss of cover.

    Once #3232 moved this read into the service's one named pre-transaction
    function, the comparison it made — "the marker appears earlier in the file than
    `withOptionalTransaction(callerTx,`" — stopped saying anything about when the
    read RUNS. It compared the position of a top-level function DECLARATION against
    the position of a call inside another one. Measured: moving
    `prepareBookingBatchModification` textually below `modifyBookingBatch`, which
    changes no behaviour whatever, turned it red; and a read inside a helper
    declared above but CALLED from inside the transaction would have kept it green.
    A rule that fails on a neutral move and passes on a real violation is measuring
    file layout.

    What actually holds the rule is `lock-bound-club-zone-outside-transaction.test.ts`,
    which confines every one of these resolvers to the module's NAMED
    pre-transaction home and is indifferent to where that home is written — it
    stayed green under the same move — plus the caller-transaction refusal below,
    which is the case no positional rule could ever express.
  */

  it("and REFUSES a caller transaction that did not resolve it first (#3232)", () => {
    // The hole the positional rule above cannot express, and it was live: this
    // service is transaction-AWARE, so a caller that supplies `tx` has already
    // taken `pg_advisory_xact_lock(1)` and the per-lodge capacity key by the time
    // control enters — and every read above `withOptionalTransaction` then runs
    // inside that transaction, this one among them, with its possible Xero
    // refresh. The only rule that holds on every path is that the mode ARRIVES
    // from whoever owns the commit (`INV-LOCK-004`).
    const source = readRepoFile("src/lib/booking-batch-modification-service.ts");
    expect(source).toContain("if (callerTx && !preTransaction) {");
    expect(source).toContain("the subscription-lockout ");
    // And the value can only have been built one way: the exported preparer takes
    // no candidate check-ins, so a caller-supplied transaction cannot hand in
    // lock-date facts resolved from a set that does not contain its own bookings.
    expect(source).toContain(
      "export async function prepareBatchModificationForCallerTransaction(options: {",
    );
    // And the mode the pricing engine is handed comes off that prepared value
    // rather than from a read of its own.
    expect(source).toContain(
      "const subscriptionLockoutMode = preparation.subscriptionLockoutMode;",
    );
  });

  it("the guest-removal route resolves the mode before it opens its transaction", () => {
    const source = readRepoFile(
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    );
    const modeRead = source.indexOf("await resolveSubscriptionLockoutMode()");
    const transaction = source.indexOf("prisma.$transaction((tx) =>");
    expect(modeRead).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(-1);
    expect(modeRead).toBeLessThan(transaction);
  });

  it("the waitlist sweep resolves the mode before it opens its transaction", () => {
    const source = readRepoFile("src/lib/waitlist.ts");
    const modeRead = source.indexOf("await resolveSubscriptionLockoutMode()");
    const transaction = source.indexOf("await prisma.$transaction(async (tx) => {");
    expect(modeRead).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(-1);
    expect(modeRead).toBeLessThan(transaction);
  });

  it("the cross-lodge promotion evaluates and reads the mode before its first lock", () => {
    // Phase 0b sits with Phase 0's minimum-stay check, ahead of the Phase 1
    // transaction that takes the offered lodge's capacity lock — the house pattern,
    // and load-bearing twice over: `resolveSubscriptionLockoutMode` can reseed the
    // financial-year cache from Xero, and the party read would otherwise take a
    // second pool connection underneath that lock.
    const source = readRepoFile("src/lib/waitlist-cross-lodge.ts");
    const modeRead = source.indexOf("await resolveSubscriptionLockoutMode()");
    const evaluation = source.indexOf(
      "await evaluateNonMemberPricingRequirements(prisma, {",
    );
    const phaseOne = source.indexOf(
      "// Phase 1 — validate the offer and re-check the quote",
    );

    expect(modeRead).toBeGreaterThan(-1);
    expect(evaluation).toBeGreaterThan(-1);
    expect(phaseOne).toBeGreaterThan(-1);
    expect(evaluation).toBeLessThan(phaseOne);
    // Fails closed WITHOUT consuming the offer, exactly as the minimum-stay branch
    // beside it does, so the member keeps their place.
    expect(source).toContain("revertOfferToWaitlisted(tx, current)");
    expect(source).toContain('code: "PAID_UP_ADULT_MEMBER_REQUIRED"');
    expect(source).toContain("paidUpAdultRefusal: buildPaidUpAdultRefusalBody(");
  });
});
