- **AI Diagnostics can now investigate one selected booking or member with
  permission-matched, read-only evidence (#2376).** Booking Officers can find a
  booking and inspect its stored state, party, links, requests, audit history,
  blockers and night-by-night capacity. Membership Officers can find a member and
  inspect their stored state, subscriptions, family links, booking involvement,
  audit history and current eligibility. Neither role needs Support & System access.

  Three tools cross that boundary deliberately and require both Bookings and
  Membership view access: a member's booking summary, a booking's blocker state,
  and the double-bed sharing verdict. The last one reads the live membership state
  and confirmed partner link for both occupants, and the other occupant can belong
  to another booking. Those cross-booking identifiers are classifier inputs only
  and are never returned; a caller missing either permission is denied before any
  membership row or partner link is queried.

  Booking blockers now use the platform's canonical persisted hosting evaluation,
  shared with the booking lifecycle rather than recreated from a proposed party.
  That preserves sparse guest nights, accepted-consent attendance, split
  parent/child coverage, subscription settlement and current-booking exclusion. A
  pending-consent adult cannot host, a split parent's adult can cover the child
  booking, and a booking cannot use itself as same-owner cover.

  Date and capacity evidence now fails closed around corrupt legacy data. Guest
  stays remain half-open: `stayStart` is the first occupied night and `stayEnd` is
  the exclusive departure day, so equal endpoints contain zero nights and are
  refused instead of becoming a fabricated one-night stay. Allocation counts read
  only the selected booking's own guests inside `[checkIn, checkOut)`, stop at the
  30-guests × 31-nights ceiling plus one, and refuse an oversized population rather
  than clipping it.

  Every authoritative answer is now bounded by PostgreSQL itself, not only by a
  JavaScript timer. The blocker state, the per-night capacity read and the member
  eligibility read each run their whole read graph inside one read-only transaction
  with a five-second statement timeout, and the transaction is passed to every
  collaborator they call. A JavaScript deadline only stops waiting: it cannot cancel
  a query, so a slow read used to keep running against the database after the
  operator had already been told the evidence was unavailable. That transaction is
  opened at repeatable-read isolation, which is what makes every fact in a row come
  from one committed instant — inside an ordinary transaction PostgreSQL still takes
  a fresh read of the data for each statement, so a row could otherwise pair a party
  counted at one moment with the lodge's occupancy counted at another. Each row still
  says plainly that being consistent is not the same as being current. The widest read —
  the sibling bookings that can supply hosting cover — gets a deterministic ceiling
  for diagnostics and refuses rather than returning a short list; the booking
  lifecycle's own evaluation is unchanged and still reads every sibling. The other
  place hosting cover can come from — the member's own other bookings at the same
  lodge — is bounded the same way, and for the opposite reason to the one that made
  the booking lifecycle's bound safe: seeing fewer possible hosts makes a booking
  writer cautious, but it makes a diagnostic report a hosting problem on a booking
  that is actually covered. Diagnostics now refuses instead, naming which population
  it could not read.

  A deleted booking now reports its deletion once. A booking can only be deleted
  after it is cancelled, so the blocker list used to carry both facts and send an
  operator to two screens when only one has a next step.

  The blocker list now includes the club's own subscription refusal. On the default
  policy, a member who owes an unpaid season subscription cannot confirm a draft
  booking at all — and because that refusal is a flat refusal at the confirm rather
  than an exception a Booking Officer can grant, the soft-policy evaluator this tool
  reuses had nothing to report, so the tool answered "nothing is blocking" about a
  booking the club would refuse. It now names the refusal, in the club's own terms,
  using the platform's single definition of an unsettled subscription so the booking
  answer and the member answer cannot disagree. It is reported only on a draft that
  costs nothing to confirm, because that free confirm is the one member-facing door
  the policy actually gates — a draft with a price is completed through the payment
  flow — and it names both ways through: settling the subscription, or an
  administrator confirming on the member's behalf. For the member-level fact on any
  other booking or any price, the member eligibility tool answers on any status.

  Membership seasons are resolved from stored settings rather than from whatever the
  process happens to have cached. The paid-up-adult rule and the hosting
  subscription bridge are handed the season the booking's own check-in night falls
  in, so a club whose financial year does not end in March is no longer judged
  against another season's subscription rows. Where the club follows Xero for its
  financial year and the month is stored nowhere local, the answer is
  `evidence_unavailable` with the remedy named, never a guess.

  Two settings reads that qualify every subscription finding — the age-tier rule and
  the club's lockout mode — are now read strictly for evidence, and handed to the
  rules rather than merely read beside them. The age-tier rule decides whether a named
  member owes a subscription, and the rules that report it reached it through a cached
  reader that answers an unreachable database with the platform's own default tiers —
  so a club that exempts a tier could have a member reported as unfinancial on the
  strength of settings nobody observed. A genuinely absent row still means the
  documented default applies; a failed read becomes `evidence_unavailable` instead of a
  confident answer nobody observed, and every rule on one row now judges the member
  against one observation of the club's policy. Ordinary booking screens keep their
  existing fallbacks unchanged.

  Being named on somebody else's booking is no longer reported as having been there.
  A member invited as a guest on another member's booking keeps that record even
  after they decline, never answer, or let the invitation expire, so the member's
  booking list used to show those bookings with no hint that the member is not
  coming. Every row now says whether the member actually counts as an occupant on
  that booking, using the platform's own presence rule — and says nothing at all,
  rather than "no", when the member holds no guest place on it, which is the ordinary
  shape of somebody who booked for other people. The bookings themselves are still
  listed, because "why is this booking in their list" is usually the question being
  asked.

  An erased account is now identified by the marker an approved deletion writes, not
  by the shape of an inactive record. Ordinary bulk deactivation is reversible and
  leaves the same shape, so both member search and the member summary used to report
  every deactivated member as possibly erased. The address stays a predicate and is
  never returned by a search.

  Whole-lodge evidence now separates current effect from historical storage,
  everywhere it appears. A booking is reported as effectively holding the lodge only
  when its raw flag is set and its canonical lifecycle state still holds capacity.
  Cancelled, bumped, deleted and otherwise non-capacity-holding records can still
  show the stored flag, but never claim an active exclusive hold — and all four tools
  that report the stored flag now name it as stored and say where the current answer
  lives. Two of them previously described it as whether the booking holds the lodge
  exclusively, so an officer asking whether a cancelled booking still held the lodge
  could be told that it did.

  Member eligibility now reads the persisted financial-year settings strictly. A
  genuinely absent singleton still uses the documented default; a rejected
  database read becomes `evidence_unavailable` instead of being mistaken for proof
  that March applies. Diagnostics still never calls Xero to fill a missing fact.

  Mobile search now normalises the stored country, area and number fragments as
  well as the operator's input, so legacy `+`, spaces, hyphens and parentheses can
  match. It uses one fixed PostgreSQL punctuation translation rather than wildcard
  or regular-expression language, and no tool returns the phone number.

  Operators must re-run `npm run diagnostics:provision-role` after deployment, and the
  guides now say plainly what the readiness screen will show until they do. This
  release both adds and removes column grants, and holding a grant the new declaration
  does not include outranks missing one — so on the ordinary upgrade path readiness
  reports "over-privileged", not "under-provisioned". Both states refuse every
  SQL-backed tool and neither is an incident; the troubleshooting table used to name
  only the second, so an operator whose tools had all failed could read the screen as
  a suspected tampered credential and escalate instead of re-running provisioning. The
  allowlist is still exactly 26 relations and 243 columns, including 23 on
  `Member`; the deployment guide now publishes every exact relation-column set and
  a test compares those sets with the source declaration in both directions, so a
  same-count column swap fails. Provisioning copy also states honestly that email
  is projected once while all three phone fragments are predicate-only.

  The opt-in real-PostgreSQL privilege proof now exercises the punctuated stored
  mobile case and fails closed during teardown: it closes restricted connections,
  terminates remaining sessions, revokes role memberships, drops owned privileges,
  drops every known-password test role and verifies that each role is absent. The
  suite remains off in ordinary local tests and runs only against the dedicated
  loopback scratch database in its hosted proof job.

  Diagnostics remains dormant until its assistant surface ships. Nothing in this
  pack can create, change, cancel, confirm, approve, refuse, allocate, move,
  complete, sign off, link, unlink or release anything, and it contacts no external
  provider. Stored text remains untrusted evidence, and invocation audit records
  contain metadata rather than arguments, results, questions or answers. The two
  searches record no argument digest where the term could be guessed: a name prefix,
  a mobile fragment, an email address, an eight-character booking reference and a
  lodge night with a closed window all have too little entropy for a hash to be
  one-way, so the tool, the outcome and the timing are recorded and the digest is
  omitted. Record-id searches keep their digest, because a cuid cannot be walked and
  "the same officer looked this record up twice" is a real audit question.
