# File-size allowances for #2723

One entry, for a route handler that was ALREADY over the 250-line budget on the
merge base. It grows only by naming, at each call site, who is writing a
credential and what that write expected to find — the two arguments this issue
makes required. The handler gained no branch and no responsibility.

The alternative was to hide both arguments behind one options object and spread
it in, and that is worse than a few lines: the census that proves no writer
omits an actor reads the call's own top-level keys and fails CLOSED on a spread,
so all nine of these sites would move into the "decided elsewhere" population
the census cannot check. Paying for the lines keeps the guard able to see them.

The sibling route — src/app/api/admin/integrations/credentials/route.ts — needs
no allowance: it hands the store its actor, expectation and request context so
the audit row commits inside the same transaction as the secret, and deleting
its own audit block left the file SHORTER than it was.

file: src/app/api/admin/backups/config/route.ts
lines: 291
reason: nine credential writes in one handler each name the actor and the write
  expectation; hiding them behind a spread would move every one of them out of
  the census's sight.
