# File-size allowance for #2940 (MiroTalk settings — review round)

One already-oversized file grows, and every added line is comment rather than
code. The rule itself is nine lines: a normalised key set built once per
object, one three-line predicate, and the two call sites that consult it.

The comment is the point. This review finding is the second half of a pattern
this module has been bitten by before — a key spelling nobody thought of,
reaching a Sentry payload verbatim — and the fix that would be proposed on
sight, an exact `"value"` entry on the denylist, is shorter, stronger, and
wrong here for a reason that is not visible from the diff: `{ label, value }`
is how this tree builds money lines, booking-history rows and option lists, so
that entry blanks dozens of operational log lines and the admin Xero panels to
catch a shape that can be identified precisely. Without the paragraph saying
so, the next single-source-of-truth or hardening pass "simplifies" the pair
test into the denylist entry and nobody finds out until an operator is reading
a log with `"value": "[REDACTED]"` where the number should be.

Splitting is the better answer where it is available and it is not available
here. Every rule in this file is consulted by `isSensitiveJsonKey`, which the
object walk, the error walk, the query-string walk and the JSON-shaped-text
walk all call; a denylist that lives in a different file from the walk that
reads it is precisely the drift the module's own header warns about, where the
text path was "quietly weaker than the object path" because it carried a second
hand-written list. One home for the rules, one for the walks, is the seam this
file already is.

file: src/lib/redact-sensitive-json.ts
lines: 889
reason: the pair rule's nine lines of code need the paragraph saying why the
  one-line denylist entry is refused, or the next hardening pass makes that
  change and blanks every `{ label, value }` money line in the logs. Splitting
  the denylist away from the four walks that read it is the exact drift this
  module's header records having already happened once.
