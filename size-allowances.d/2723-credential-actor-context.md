# File-size allowances for #2723

Two entries, both route handlers that were ALREADY over the 250-line budget on
the merge base. Neither gains a branch or a responsibility: they grow by naming,
at each call site, who is writing a credential and what that write expected to
find — the two arguments this issue makes required.

## What the alternative would actually cost

The obvious saving is to hide both arguments behind one options object and
spread it into each call. It is worth being precise about what that loses,
because a first draft of this file overstated it: the census classifies these
sites as `forwarded` today — their actor is a hoisted `const`, not an inline
literal — and a spread would leave them `forwarded` too, so the claim that a
spread moves them into a population "the census cannot check" was wrong.

What a spread really costs is the discrimination underneath that word. Reading
`actor` and `expect` as top-level keys, the census can tell a key that is
PRESENT from one that is ABSENT: an omission at any of these nine sites lands in
`actorless` or `expectationless`, and those two populations must be empty — they
are the gate. A spread of an identifier marks the whole object `unreadableKeys`,
and every lookup on an unreadable object must fail CLOSED, so both keys report
as "decided elsewhere" whether they are there or not. The omission the gate
exists to catch becomes indistinguishable from the legitimate forwarding, at the
one handler that holds nine of the tree's twenty-one credential writes. That is
the trade: a few lines of naming, against a gate that can still see these sites.

file: src/app/api/admin/backups/config/route.ts
lines: 291
reason: nine credential writes in one handler each name the actor and the write
  expectation as top-level keys, so an omission at any of them still lands in
  the census populations that must be empty. Behind a spread the object reads
  as unreadable and both keys fail closed to "decided elsewhere", which is the
  same answer a missing key would give.

file: src/app/api/admin/integrations/credentials/route.ts
lines: 297
reason: nine lines, five of them #2723's and four #2940's. Re-measured IN PLACE
  rather than declared again: this allowance was merged into `epic/2725-mad`
  but the ratchet measures against `origin/main`, so it is still live, and
  "one file, one allowance" refuses a second entry naming this path — the
  number here has to describe the file as it now stands. #2940's four are the
  import of `INTEGRATION_CREDENTIAL_VALUE_MAX_LENGTH` and the comment saying
  the cap is the store's own: this route and the MiroTalk credentials route had
  each spelled the bound themselves, and two doors disagreeing would mean a
  value one stores and the other refuses. The rest is #2723's and unchanged.
  The #2723 change itself left this file SHORTER than it found
  it — its hand-written audit block moved into the store, where the row commits
  in the same transaction as the secret — and no allowance was owed. The fix
  round put back only what the fix needs: the verify-reset helper now takes the
  acting member and the request context and passes them to the two marker
  deletions, so one administrator's Save records one writer instead of a person
  plus a job with a null member. That is two parameters, one hoisted request
  context and the `import type` that names them. There is nowhere else for any
  of it to live: the helper is where the resets are dispatched and the guard is
  where the member id arrives.
