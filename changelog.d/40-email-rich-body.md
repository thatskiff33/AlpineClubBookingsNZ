- **Email bodies are now edited in a rich editor — bold, italic, underline,
  lists and alignment, styled as you type (fork #38).** The Admin → Email
  Messages body editor works like the message board's composer: select text,
  use the toolbar, and see the styling in place; Preview still shows the
  exact email a member receives, and `{{tokens}}` work exactly as before.
  Colours, fonts, sizes, images and links are deliberately not offered, so
  every email stays on the club's theme in every mail client — and anything
  pasted from elsewhere is reduced to the allowed formatting on save, so
  pasted content can never reach a member as raw markup. Wording saved
  before this release keeps rendering exactly as it always has until an
  admin re-saves it from the new editor (it opens as plain paragraphs, ready
  to format).
