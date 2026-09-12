# File-size allowance for #3366 (stage 1 of programme #2912)

One already-over-budget file grows, by three lines, and the growth is one row of
a declarative table plus the two-line comment saying why that row's key is what
it is.

file: src/lib/member-merge.ts
lines: 2834
reason: `GENERIC_KEYED_RESOLVERS` is the merge's declarative collision table,
  and the schema completeness test fails CI for any Member relation with no
  bucket — so the new `OrganisationContact.member` relation has to appear here
  in the same change that adds the relation, not a release behind it. The row
  itself is a single line in the same shape as the fourteen above it; the other
  two lines say that the table is keyed on `organisationId` because one person
  holds at most one association per school, which is the fact a reader would
  otherwise have to go and derive from the schema. Splitting is not available
  in any useful form here: a resolver entry that lives away from the table it
  is read out of is exactly the drift this table exists to prevent, and the
  table is deliberately one place so the execute-time resolvers and the preview
  drop-note summariser can never disagree about a key. The longer reasoning —
  the bucket, why `role` is not consulted, and why the classification arrives
  with the relation — is in `member-merge-relations.ts`, which is not over
  budget, so only the irreducible part is here.
