- **The club now decides what a member reads on their own activity history,
  instead of it being decided by accident (#2695).** An audit entry's free-text
  note used to reach the member whenever it happened to be an ordinary sentence,
  and stay hidden whenever it happened to be stored as structured data. Nobody
  chose that, and two consequences were live: an administrator declining an
  account-deletion request typed a note on the same form as the **Do not notify
  the member** tick and the member read it anyway, and a member receiving a
  credit adjustment read a sentence written for officers, naming two internal
  record numbers and the member who had requested it.

  Each kind of event now states what the member may read, and an event that
  states nothing shows the member nothing. What a member still sees is the
  reason their credit balance moved — the only explanation they ever get for it,
  now written for them rather than borrowed from the officers' copy — and the
  note that comes with a booking review, change-request or policy-exception
  decision, which is the same note already emailed to them. An officer's private
  note has never been on the audit entry at all.

  **The downloadable copy of a member's data follows the same rule.** Profile →
  Export my data used to put the stored note of every audit entry about that
  member into the file, whatever it said — so the deletion-decline note written
  under **Do not notify the member** came back in the download even though it
  had never appeared on screen. The file now carries the same words the member's
  own history shows, and nothing else.

  **Officers lose nothing:** every entry keeps its full wording on Admin → Audit
  Log. The change applies to entries recorded before the upgrade as well, so an
  older deletion-decline note stops being visible to the member from the day you
  upgrade — nothing is deleted, and anyone with audit access can still read it.
  **That cuts both ways, and it is worth knowing before you upgrade:** an older
  entry states nothing about the member either, so a member who received a
  credit adjustment last season no longer sees the recorded reason for it on
  their history or in their download. The credit itself, its amount and its date
  are unaffected, and the reason is still on the entry for any officer to read.

  Three smaller repairs ride along. An entry's short title is now held to the
  same secret and card-number rules as its note, which it previously skipped.
  The title a member sees for a setup-invite or password-reset entry is no
  longer built out of the stored payload, which on an officer's own timeline
  could name a different member's email address. And an entry saved with a blank
  title now reads the same to a member as it does to an officer, instead of
  showing the member an empty row.
