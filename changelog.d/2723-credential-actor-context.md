- **Changing a stored integration credential now always records who changed it (#2723).**
  The encrypted store that holds the Xero, Stripe, Google, backup, Anthropic and
  Alpine Central Server credentials keeps a note of who last wrote each one. Until
  now that note could be left blank, and most of the places that change a
  credential left it blank — so an entry written by a background job and one
  written by an administrator who was simply not recorded looked identical in the
  audit log. Deleting a credential could not record anybody at all. Every write now says which administrator made it, or names the
  background job that did, and the code refuses a write that says neither.

- **The audit entry for a credential change can no longer go missing (#2723).**
  The credential and its audit entry are now saved together: if the entry cannot
  be written, the credential change is undone rather than left with no record. And
  several paths that changed a credential without writing any entry at all — the
  Google and Stripe verification markers, the Alpine Central Server push
  registration, the Xero token key, and every credential deletion — now write one.
  Simply reading a credential still records nothing, so status checks do not fill
  the log.

- **Two administrators editing the same credential at once no longer overwrite
  each other silently (#2723).** A write can now state what it expected to find,
  and one that finds something different is refused with a clear message instead
  of quietly replacing the other person's change. Nothing an administrator does
  today behaves differently; this is the groundwork for the club-editable
  integration settings that follow.
