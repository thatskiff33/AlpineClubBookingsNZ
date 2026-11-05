- **Stored credentials and two-factor secrets can now be protected by their own
  key instead of the sign-in secret (#4456).** Until now `AUTH_SECRET`, which
  signs every session, was also the key every stored provider credential (Xero,
  Stripe, Google, backups, the AI and Alpine Central Server keys) and every
  member's authenticator-app secret was encrypted under. A leak of that one
  value exposed all of it, and changing it after a leak destroyed it.

  A new, optional setting, `DATA_ENCRYPTION_KEYS`, holds a separate key (or a
  list of them, the first used for new data). Once it is set, new and re-saved
  credentials, authenticator enrolments and Xero token refreshes are encrypted
  under it, and the auth secret can later be rotated without losing them.
  The site runs unchanged until an operator sets it, but Admin → Setup has a
  new "Data Encryption Key" step saying what is still on the auth secret, and
  on a club with a stored provider credential or authenticator-app secret that
  step is red, so the setup report shows blocked and `pnpm run setup:check`
  exits 1 until a key is set.

  **What to do:** read "Data-encryption keys" in `CONFIGURATION.md` and "Adding
  a data-encryption key" in `DEPLOYMENT.md`. Set the key only after every
  container runs this release. **Recovery codes issued before the key is set
  stop working when it is set**; affected members see a notice at sign-in and
  on their profile asking them to generate new ones, and admins should
  regenerate their own straight away. Until a later release deletes them, the
  old codes work again on any server without the key. Add a newer key later in
  two redeploys, as `DEPLOYMENT.md` describes.
