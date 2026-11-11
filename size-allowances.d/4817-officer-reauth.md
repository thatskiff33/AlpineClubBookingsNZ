# File-size allowances for #4817

Sign-in now records when the person last proved who they are (#4616). The
claim is written only inside the session callbacks, and an account erasure
deletes the short-lived challenge beside the other credentials it already
clears. Both files were already over budget; the growth is that wiring.

file: src/lib/auth.ts
lines: 868
reason: lastAuthenticatedAt is stamped beside sessionIssuedAt in the jwt
  callback, and refreshed only when that callback consumes a server-minted
  challenge. The consume helper already lives in session-reauth.ts; what
  remains here is the claim, the two stamps, the update-trigger call, and
  copying the claim onto the session. Splitting the jwt callback out of
  auth.ts to save those lines would separate this claim from the sibling
  claims written in the same callback.

file: src/app/api/admin/deletion-requests/[id]/route.ts
lines: 1296
reason: the erasure transaction already deletes the member's two-factor
  session challenges in the same list. A reauthentication challenge is the
  same kind of row — short-lived, bound to one member, and useless once the
  account is erased — so its delete belongs in that list. Lifting the
  credential sweep out of this route to save three lines is a refactor of
  its own.
