> **DECIDED by owner, 2 Oct 2026 NZ:** the [naming repair blueprint](http[historical local path omitted]) is approved in the [owner reply](http[historical local path omitted]). PR #3719 has merged into epic #3678; residual issue #3794 carries the recovered regressions, member-identity guard and approved provisional-price reconciliation in a follow-up epic-targeted PR. Final integration and production cutover remain separately gated.

> **DECIDED by owner, 28 Sep 2026: maintenance-window cutover for the unnamed-adult capacity change.** The owner approved the [revised High-risk blueprint](http[historical local path omitted]) with old web and workers stopped before pending-adult writes are enabled. This is approval to implement, not authorization to run a production cutover or merge the final High-risk integration PR. Its deployment/rollback stop checks are binding.

> **DECIDED by owner, 27 Sep 2026: support an explicit count of adults whose names are pending (option 2).** This is a count, not generated teacher identities. Officers may quote for these adults, but booking conversion must wait until each has a real name. The owner made this choice in the working session; this body records it.

## What happens today

The original officer report on 13 Sep 2026 concerned a school whose adult count had changed. At that time the officer panel changed Infant / Child / Youth counts but told officers to decline and ask the school to resubmit if teachers or parent helpers changed. Since then #2936 shipped a “Correct this request” editor: an officer can add or remove **named** teachers, with a first and last name required and email optional. A changed party reopens the request, clears its old price, supersedes a sent quote and releases an affected capacity hold so the officer can re-price and re-quote. That solves the original problem when the school knows the adults' names.

The remaining gap is a school that knows the number of adults needed for a quote but cannot yet name every one of them. Today's correction editor cannot save those additional adults without invented names.

## Who it affects

Booking officers and schools that need an accurate capacity and price decision before their final staff or parent-helper list is known. Declining and resubmitting loses the request's history and creates extra work; inventing names risks false school contacts, incorrect guest/member matching and, when enabled by #3416, hut-leader assignments or PINs for unidentified people.

## Proposal and settled choice

Add an explicit, visible **unnamed adult count** to the school request correction and quote flow. It represents people whose identities are pending; it must never be stored or displayed as if “Parent helper 3” were a real first/last name. Include the count in adult headcount, capacity, price and quote/hold snapshots. Let officers turn each pending slot into a named adult before conversion. A quote may be sent and accepted while names are pending, but the officer approval that converts the request into a booking must stop with an actionable message until every adult is named. Keep the #2936 named-teacher correction path and its safe quote supersession/hold-release behavior.

The High-risk blueprint must specify the one canonical representation, request and quote snapshot rules, correction and member-link handling, what happens when names arrive after acceptance, the capacity-lock and version claim, validation at both general and school approval boundaries, requester/officer copy, tests and recovery. Coordinate with #3415's accepted-quote officer-review state and #3416's default-OFF teacher hut-leader setting. Do not weaken the Organisation/Xero real-contact contract introduced by #3455.

## Alternatives considered

- [ ] ~~Close #3413 as fulfilled by #2936.~~ This solves named teacher add/remove, but leaves the newly confirmed quote-before-names workflow unsupported.
- [x] **Chosen: a separate unnamed-adult count with real names required before conversion.** The count remains plainly unidentified until resolved.
- [ ] ~~Generate placeholder first/last names such as “Parent helper 3”.~~ This masks pending identity as a person and could flow into contact, member or hut-leader records.
- [ ] ~~Keep decline and resubmit.~~ Rejected by the original officer report for a small count correction.

## Existing decisions carried forward

- Removing or shifting a member-linked guest must not silently attach that member to someone else. #2936 currently clears positional member links when the party changes and makes the officer re-link them; retain or strengthen that identity rule rather than adopting the old “unlink first” question literally.
- A changed party invalidates any old sent quote and reconciles the old capacity hold; a new quote must describe the corrected party.
- A school request retains at least one real named teacher unless a separately reviewed product contract changes that requirement.

## Scope and risk

High: capacity, quote pricing and snapshots, school guest/member identity, request-to-booking lifecycle and contacts. A dedicated branch/worktree and PR target `epic/3678-officer-quote-school-wave`; the integration PR requires exact-head CI and an owner-authored merge approval. The owner approved the revised current-main blueprint on 28 Sep 2026 with a maintenance-window cutover and its rollback preconditions. No production cutover is part of this coding session.

