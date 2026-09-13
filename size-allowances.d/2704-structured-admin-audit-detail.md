# File-size allowances for #2704 — structured admin audit detail

Two already-over-budget files grow, and **the split was taken first**: the rule
itself — what a reduction may and may not do to a value, the recovery of a
legacy clipped payload, and the reasoning for both — is a new module,
`src/lib/audit-structured-detail.ts`, comfortably inside its own budget. What is
left in the two files below is the call sites and the two boundaries this change
decides, not the explanation of either.

**Both entries were first written into `size-allowances.d/2695-member-visible-audit-text.md`,
and moving them here is the correction.** #2695 has not reached `origin/main` —
the base the gate measures against — so its fragment is still live in this
change's diff, and a SECOND live allowance naming the same path is refused ("one
file, one allowance"). Editing a sibling's fragment avoids that refusal, but it
turns that lane's per-lane file into the shared list `AGENTS.md` → "Change
Discipline" exists to abolish, on an epic branch where more than one lane is in
these modules. MOVING the two entries satisfies the gate the same way and keeps
the rule: a lane adds a file. #2695's fragment keeps its other five entries
untouched, and the reasons below now have to carry both issues' growth, which is
why each says whose lines are whose.

file: src/lib/audit.ts
lines: 928
reason: #2704 adds 91 of these lines and #2695 the rest. #2704's share is the
  `details` column's over-budget branch and the two boundaries around it. A
  payload that FITS takes the text rule byte for byte, so no stored row whose
  meaning anybody relies on moves; one that does not is sanitised as a VALUE and
  reduced ONCE, and the docblock is most of the share because it has to record
  what that second boundary really does. The first draft claimed the metadata
  rule "redacts strictly more" than the text rule, and that is false: the two
  are incomparable, and a card number used as a KEY NAME is redacted by the text
  rule and survives the metadata rule. Unreachable with today's literal key
  names, and out of scope to close here — this issue's contract keeps redaction
  a separate audit responsibility — so what the comment owes is the truth, at
  length, where the next reader will look for it. The rule itself and the
  measured `"amountCents":1` case are NOT restated here; they live in the new
  module. It cannot move: this is the sanitiser for one column, and a column's
  write boundary is where a reader looks for what that column stores. #2695's
  share, below, is unchanged. The two write boundaries route their metadata
  through one new builder, and the docblock on it is the deliverable rather than
  decoration — the ORDER it imposes is load-bearing and invisible from the code.
  The caller's metadata is sanitised first and the declared member text attached
  afterwards, because merging the text in first would let an over-budget payload
  silently delete what the member reads. That is the same defect as the shape
  test #2695 removed, in a second disguise, and the next person to "simplify"
  the two steps into one will reintroduce it. The rest is the optional
  `memberDisclosure` field on both writer param types, said once and re-exported.

file: src/lib/audit-query.ts
lines: 1324
reason: #2704 adds 42 of these lines and #2695 the rest. #2704's share threads
  one fact — the `details` column holds a payload, parsed or rebuilt — through
  the serializer, `projectFreeTextForAudience` and `getDescription`, so a legacy
  clipped payload renders as fields instead of being handed back as a sentence.
  It has to be threaded rather than re-derived at each reader: three readers
  each asking "did it parse?" is how the audience came to be a property of the
  JSON parser in the first place, which is the defect #2695 removed from this
  same file. The recovery ITSELF is in `audit-structured-detail.ts`; what is
  here is only the wiring and the two comments saying why the raw column stays
  on screen beside a recovered view. #2695's share, below, is unchanged.
  `projectFreeTextForAudience` answers every free-text field for both audiences
  in one exhaustive place, replacing three ternaries spread through the
  serializer, and `storedSummary` beside it is the single fallback rule the two
  audiences' row titles share — written twice with two different emptiness
  tests, it showed a member a blank row title where an officer saw the derived
  one. It cannot move to `audit-member-disclosure.ts`: it composes `getSummary`,
  `getDescription` and the legacy-metadata parse, all of which live here, so
  lifting it out means either a circular import or four callbacks passed in to
  reach the same result. Its docblock carries why the audience must be answered
  in one place at all — `INV-PRIV-012` records a guard on this surface that was
  measured to survive deletion with the word left behind in a comment.
