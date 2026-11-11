# File-size allowances for #4994

The rule for which proofs start the five-minute clock lives in
`recent-auth.ts`. What remains in the session callback is the claim itself:
which provider signed in, and the stamp after the member reload that already
sits in this callback.

file: src/lib/auth.ts
lines: 903
reason: the password stamp has to be decided after the member reload in the
  same jwt callback that already writes the other session claims. The
  predicate lives in recent-auth.ts. Splitting the callback out to save
  these lines would separate this claim from the sibling claims written
  beside it.
