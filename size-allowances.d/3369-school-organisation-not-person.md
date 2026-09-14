# File-size allowances for #3369

Seven already-over-budget files gain the lines that say what a school booking
means to them — the branch where a member ledger, a member preference or a
member id was assumed, and the comment recording which of those was a decision
rather than a fall-through.

**Splitting is not available for any of them, and that is the shape of a stage-4
change rather than a failure to try.** The growth is not this change's subject.
The subject is that `Booking.memberId` became optional, and the compiler then
pointed at every place that had assumed otherwise. A file is on this list
because it made that assumption and is already over its ceiling, not because
#3369 added anything to what it does. Splitting a module to pay for a
five-line branch would be a larger and riskier change than the one under review,
and it would bury the property this stage has to prove: that a school renders
the same bytes the invented school member rendered, and that every place where
it cannot says so.

Fifteen more files are not listed, and five of them are the interesting ones:
they sat AT or just under their ceiling, where an allowance is not permitted
because it would carry a file over budget for the first time. Each was brought
back inside by shortening what this change added to it — and one of them paid
for itself properly: the account-credit refusal that four settlement paths
needed is now `requireMemberCreditRecipient` in `member-credit.ts`, one home
instead of four copies, which is both the smaller change and the right one.

The #3368 allowance file's numbers were RE-MEASURED rather than duplicated here
(`size-allowances.d/README.md`: one entry per path). That stage's entries are
still live in a diff against `main`, so a second entry for the same file would
be two allowances describing one length.

Each entry records the file's length after the change.

file: src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx
lines: 818
reason: fifteen lines. The redemption table linked every row to a member page; a school has no member page, so the cell renders the name and address without a link when the id is null. The branch is JSX and cannot be smaller than the two arms it has. The panel is one table with its filters and its export, and splitting the cell out would put a four-line conditional in its own file.


file: src/app/api/admin/promo-codes/[id]/redemptions/route.ts
lines: 401
reason: twenty-three lines. The row's party is the booking's OWNER now, so the route selects it, names a school through the projection, links only where there is a member page to link to, and skips a redemption that names nobody when counting a member's uses. Each of those is a different question and the comments say which; the route is one handler over one query and splitting it would separate the select from the mapping that reads it.


file: src/lib/booking-guests.ts
lines: 833
reason: twenty-six lines across two guards and their reasons. With no booker there is nobody to share a family group with and nobody to confirm a delegated profile, so both halves are false — which is the fail-closed side AND exactly what the invented school member already produced, since it belonged to no group. That equivalence is the whole argument that consent behaviour is unchanged for a school, and it is worth the lines to state where the guards are.


file: src/lib/email/booking.ts
lines: 1728
reason: seventy-eight lines, and seventy-two of them are the same six-line docblock on thirteen sender parameter shapes. Each says that a null recipient is the school, and that it becomes the non-login public-contact identity — which is what a school has effectively always been, since the invented member could not sign in. One shared sentence would be smaller and worse: a sender's own parameter is where somebody choosing a value looks.

file: src/lib/group-booking.ts
lines: 1886
reason: eleven lines. A group booking is organised by a PERSON who hands out a join code, and a school is not one, so the create refuses in words rather than leaving a required column to fail on a null. Nine of the eleven are the refusal and its reason.



file: src/lib/member-guest-email-notes.ts
lines: 831
reason: seven lines: one widened field and its six-line reason. The note's facts type is now exactly the shape `evaluateGuestSelfRemoval` takes, because the note CALLS that predicate — and two facts types differing by one nullable field is how the note and the server's verdict drift apart.

file: src/lib/promo.ts
lines: 2004
reason: forty-one lines across three places. An unassigned promotion attributes its whole benefit to the booker, and a school has none — so the officer is told so in words before pricing runs, pricing throws if anything reaches it anyway, and the booker fallback writes no allocation naming nobody. The throw's comment is the longest of the three because it records the FIFTH member-linked model a school booking can reach (`BookingGuestNightAdjustment.beneficiaryMemberId`), which the #2912 census did not name and which this path is why nobody has to widen.
