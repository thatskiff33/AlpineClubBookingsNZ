# AI Diagnostics — the operator surface

What an administrator actually sees, touches and is told. The hub
([`README.md`](README.md)) holds the architecture, the permission model and the
owner decisions; this document holds the screens.

**One home per statement.** Where a rule is a security decision it is stated in the
hub and only pointed at here. Where it is something a person sees, it is stated here
and only pointed at from the hub.

Delivered by AID-7 (#2378). ADR-008 governs how an answer is rendered
([`decisions/ADR-008-answer-output-channel-inert-render-csp.md`](decisions/ADR-008-answer-output-channel-inert-render-csp.md)).

---

## The two surfaces

| surface | owns | why |
|---|---|---|
| `/admin/ai-diagnostics` | setup and status — readiness, the monthly budget | it is where you go when it is *not working* |
| the **Help** bubble, on any admin screen | the conversation — asking, consent, evidence, provenance | it is where you are when you have a *question* |

That split is owner decision D8, and it is load-bearing rather than cosmetic: the
consent ticks, the evidence display and the transcript hardening are built and
reviewed in ONE place instead of two that drift. It is also why the bubble shows no
readiness detail of its own — a second readiness surface is exactly the drift D8 rules
out, so a deployment that is not ready says so through the server's own refusal copy,
which points at the page.

## Switching it on: where your data goes

The AI Diagnostics card on Admin → Modules states, before it can be switched on,
that each question sends excerpts to Anthropic, which may process them outside New Zealand,
what those excerpts are, and that retention is arranged between the club and
Anthropic on the club's own account. Ticking the module adds a second tick — "I
understand…" — and Save stays disabled, with a one-line hint, until it is ticked.
Unticking the module clears it. The tick appears only for a save that switches
Diagnostics on: switching it off, or saving other modules while it is already on,
asks for nothing. `/admin/ai-diagnostics` repeats the statement, without the tick,
under "Where your data goes". See the
[deployment guide](deployment.md#provider-disclosure-and-retention).

## The route in, from a standing start

1. An admin opens any admin screen. If their role and the module both allow it, the
   Help bubble carries a third tab, **Diagnostics**, beside Ask and Page guide.
2. On the **bookings**, **booking requests**, **waitlist** and **payments** lists,
   each row carries a stethoscope. Pressing it makes that row the subject and opens
   the bubble on
   Diagnostics. On `/admin/members/[id]` the address already names the record, so no
   control is needed.
3. They tick either, both or neither consent box, type a question, and send.
4. The answer arrives with a one-line provenance summary under it, which expands.

What travels with a question is the **pathname**, the operator's chosen **record id**
(a selector the server re-resolves; the kind always comes from the route the server
matches), the replayed transcript, and the two ticks.

### The question also carries what the page is filtered to (#2816)

The channel is the page's own **applied** state, not the address bar (owner decision,
13 Aug 2026). Each wired list publishes the filters that actually reached its query —
post-parse, defaults included — and a page that publishes nothing falls back to the
bubble reading the query string at ask time. The mechanism, and the four pages wired
so far, are in [`page-context.md`](page-context.md#where-the-view-state-comes-from);
the route then keeps only what the matched registry row's allowlists permit and drops
the rest silently, because one stray pagination key must never cost the whole context.

The address bar was rejected as the channel because on these pages it is routinely
not what the operator is looking at. Payments defaults its activity window to the last
three club-timezone months in **React state**: a bare `/admin/payments` is already
filtered by a window nothing in the address named, and the page's own URL sync effect
only writes it there afterwards — and that window is the single most common reason a
payment an operator expects is not on screen. The bookings parse is total, so one
malformed date drops **every** filter while the URL still displays them all. And a
page whose load failed publishes that failure, where the address cannot express it at
all: it still shows the filters, on a screen with no list behind them.

**The operator is told, beside the input, that this happens.** The disclosure sits in
the Diagnostics panel above the question box rather than in a document, because that is
where the sending happens:

> The filters and search on this page — including anything you have typed into a search
> box — travel with your question, so Diagnostics can see the list you are looking at.
> The boxes above do not affect that.

Its last sentence is the load-bearing one. **A typed search term travels ungated by
either consent tick** (owner decision, 13 Aug 2026): the ticks govern reading a
record's personal details and searching for people, not the filter state of the screen,
and a control sitting directly above something it does not govern would be read as
governing it.

## The Diagnostics tab

A third tab beside Ask and Page guide, present only for an administrator the layout
granted it — the prop's PRESENCE is the permission and `moduleEnabled` is the module
flag. Its conversation object is separate from page help's, deliberately: one shared
transcript would send page-help turns to the diagnostics model and diagnostics
answers, which carry evidence about real people, to the page-help endpoint.

The panel is **resizable** (comfortable / tall / full screen, plus a drag handle),
because 24rem is tight for an answer carrying several blocker codes and its
provenance. The resize is keyboard-operable, not drag-only, and the choice is
remembered per browser.

The Diagnostics tab is **exempt from the route-change tab reset**. Page guide is
page-specific and genuinely stale after a navigation; an open investigation is not.

### The two ticks are per QUESTION

Both appear on every question and both start unticked (owner decision D9): one to
include the selected record's personal details, one to let the assistant search for
people and records. AID-7a grants each per REQUEST, so a tick that looked
session-wide would be the UI claiming an authority the server gate does not give it.
They reset after every send **including a failed one** — the worst version of getting
this wrong is an operator retrying and silently reusing a permission they granted for
a question that never ran.

The labels are the server's own words, imported rather than retyped, because a
checkbox whose label disagrees with the server's behaviour is worse than no checkbox.

## Failure states

#2378 requires these to be first-class UX rather than a generic "AI failed". Each row
says where the state is produced and what the operator is told to do next.

| # | state | where it comes from | what the operator gets |
|---|---|---|---|
| 1 | module disabled | route gate 3 + the bubble's own module-off panel | "AI Diagnostics is switched off", link to Feature modules. The route's 404 is byte-identical to the feature gate's |
| 2 | configuration incomplete | route gate 9 (dedicated credential) | `not_configured` for a caller with `support:view` — someone with support access can add the key. Anyone else gets the coarse `not_ready`, because the stored-credential state is itself support-only detail |
| 3 | coarse readiness blocked | route gate 8 | `not_ready` — open the page to see what is needed |
| 4 | detailed readiness permission denied | `readinessForAdmin` | the coarse tier plus "who can resolve this" — never a blocker list with fields blanked |
| 5 | missing / under-provisioned database evidence | evidence states `not_configured` / `not_ready` | which part is not set up, versus set up and drifted |
| 6 | budget exhausted / reservation refused | `reserveDiagnosticsBudget` | `budget_exhausted`, and the input disables for the rest of the session |
| 7 | rate limit | route gate 2, before the body is read | wait a minute or two. The per-admin limiter's 429 gets the client's own copy of that sentence (a 429 carries no diagnostics body); the global backstop's `rate_limited` is server copy. Never "check your connection" |
| 8 | tool-loop limit | the loop's round ceiling | `round_limit_reached` — ask about one booking, member or payment at a time |
| 9 | circuit breaker | route gate 6 (metering) | `metering_unavailable` — it cannot record what it spends, so it will not spend |
| 10 | tool timeout | evidence state `temporarily_unavailable` | trying again shortly is reasonable |
| 11 | bounded result / partial evidence | evidence state `result_truncated` | `hasPartialEvidence` on the collapsed line: only part of a longer result |
| 12 | stale page context | the bubble's moved-screen notice (+ `hasStaleEvidence`, which the loop keeps wired but nothing produces — each question gathers its own evidence, so a retrieval is never itself stale) | the LAST question was asked from another screen; answers from here on are about this one |
| 13 | record not found vs not authorised | evidence states `not_found` and `permission_denied`, kept separate | a denial names the missing AREA; an empty result says nothing matched. Neither is inferred from a source the caller does happen to hold |
| 14 | people search not enabled | evidence state `search_consent_required` | `hasSearchWithheld` — tick the search box if you want it to look |
| 15 | record / sensitive consent not granted | evidence state `consent_required` | `hasConsentWithheld` — names both controls and asserts neither cause, because four causes land here |
| 16 | runtime evidence unavailable, deployed evidence available | evidence state `evidence_unavailable` beside `ok` sources | the answer still lands, with the gap named in the collapsed line |
| 17 | session expired / access changed mid-conversation | the client, on a 401/403 | "your session no longer allows this — sign in again". Never rendered as a network fault |
| 18 | transport failure | the client, when no response arrives at all | "check your connection" — the one state where that sentence is true |
| 19 | stored provider evidence (#2815) | the answer loop folds `provider_check_required` onto an otherwise-clean read from a tool carrying the stored-provider disclosure (the finance pack, plus the two membership tools whose subscription fields mirror a Xero invoice); the collapsed caveat itself keys on the TOOL, so truncated and empty reads carry it too | `hasProviderCheckRequired` on the collapsed line: "provider state here is what the platform last recorded, not a live answer — confirm against Stripe or Xero's own console before acting on it". The evidence still counts as READ — the state qualifies its liveness, not its retrieval |

Two properties hold across the whole table:

- **Every blocked REASON has server-owned copy**, as a total record, so a new reason
  cannot ship without an operator sentence, and the UI renders it verbatim. The
  client owns exactly the sentences no server copy can exist for — the 429 (no
  diagnostics body), the 401/403, and the transport failure.
- **None of them invites a reload** (#2804). A reload during database contention adds
  another queued reader and makes the cause worse — and the conversation lives only
  in the browser, so a reload also costs the whole investigation. "Try again
  shortly" is a deliberate, different instruction from "refresh the page". A census
  (`answer/__tests__/contract.test.ts`) walks every entry of the blocked-copy table
  and the client's own sentences and fails any that invites one.

A census test iterates `DIAGNOSTICS_EVIDENCE_STATES` itself and requires every state to
be placed deliberately on one side of "does this raise a caveat". It is fail-closed:
the allowlist is the states that may pass WITHOUT one, so a new state added
next year lands on the caveat side and fails until somebody decides.

## The "still working" state

A diagnostics read may wait around fifteen seconds for a busy database (#2804), and
that was accepted only on condition the wait never reaches a screen without a progress
state. It appears after four seconds, well before the worst case, as `role="status"`
with `aria-live="polite"`; the elapsed counter is `aria-hidden` so a screen reader
hears the sentence once rather than a new number every second.

## Choosing what the question is about

The stethoscope on a row sends an **id and nothing else** — not the kind, not a field,
not the label beside it. Why that is the shape, and why a picker inside the panel was
rejected, is a security argument and lives in the hub under
[Naming the record](README.md#naming-the-record-owner-decision-d11).

What an operator needs to know about it:

- Pressing it on a second row simply moves the subject to that row.
- Pressing the same row again reopens the panel if it was closed.
- **Navigating away drops the subject**, while the conversation stays. The next
  question is about the screen in front of them. This is deliberate: the server works
  out what KIND of record you mean from the page you are on, so a booking carried onto
  the payments list could only ever ask about a payment that does not exist.
- The approvals queue (a tab of `/admin/booking-requests`) carries the stethoscope
  too — #2812 closed what used to be a documented gap here, retargeting its dead
  registry row (which named a redirect-only address) at the real page.

## Accessibility

The evidence-heavy conversation has to be usable without a mouse or a large screen,
which #2378 sets as a requirement rather than a nicety.

| behaviour | how |
|---|---|
| keyboard only | every control is a real `button`, `input` or `textarea`; the panel resize is keyboard-operable through the preset cycle, with drag as an addition rather than the only way |
| focus | focus moves into the panel on open and returns to the launcher on close; every control carries a visible focus ring |
| the row control | its accessible name names the ROW — "Ask diagnostics about the booking for …" — because a table of identical "Ask diagnostics" buttons is unusable with a screen reader |
| the consent ticks | real checkboxes in a `fieldset` with a `legend` reading "For this question only", each with its own label and description |
| progress | `role="status"` + `aria-live="polite"`, announced without interrupting; the elapsed counter is `aria-hidden` so the sentence is heard once rather than a new number every second |
| provenance | the collapsed line is a `button` with `aria-expanded`; the caveat is IN the collapsed line, so it reaches a screen-reader user without them opening anything |
| narrow screens | below the `sm:` breakpoint the panel is a bottom sheet and a dragged pixel width is ignored, because it would fight the layout rather than help it; on iOS the panel lifts by the on-screen keyboard's height so the focused control stays visible |

## What the surface never shows

From #2378's own list, and enforced server-side rather than by what the components
happen to render: raw or model-generated SQL, raw tool arguments or unrestricted
result objects, provider request/response payloads, internal prompts or system
instructions, raw stack traces, credentials or tokens, fields the acting admin lacks
permission to read, unrestricted bulk personal data, and live Stripe/Xero/banking
reads.

The provenance line is held to the same rule: it names WHERE evidence came from and
WHAT was missing from it, never a record id, a personal field, a tool argument or a
row's contents.

## Related documents

- [`README.md`](README.md) — the hub: architecture, permissions, owner decisions.
- [`page-context.md`](page-context.md) — what the server accepts as a page selector.
- [`tools.md`](tools.md) — the tool substrate and its evidence states.
- [`../UX_FLOW_MAP.md`](../UX_FLOW_MAP.md) — where this sits among the app's flows.
- [`../guides/ai-help.md`](../guides/ai-help.md) — operator-facing help copy.
