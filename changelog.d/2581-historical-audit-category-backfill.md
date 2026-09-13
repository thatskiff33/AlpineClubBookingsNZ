- **Older activity entries that had no category now have one, from an exact list
  (#2581).** Until the previous release made the category mandatory, many of the
  platform's writers recorded activity entries with no category at all, and the
  category is written onto the entry when it is recorded rather than worked out
  when you look at it — so every entry those writers recorded before that release
  still had none. Such an entry was returned by no AI Diagnostics correlation tool
  and was placed by **Admin → Audit Log**'s Category filter only by guessing from
  its event name. On the deployment this was measured on that was 1,885 entries
  across 83 event types.

  This upgrade gives each of those entries the category its event type records
  today, matched by the entry's **exact event name** against a reviewed list,
  never by pattern; every event type on the list was proven against the code that
  records it now, or, for three the platform no longer records, against the code
  that did. It changes **one field** on each entry: the date, who did it, who it
  was about, the summary, the stored details and the retention fields are exactly
  as they were — and the retention fields are deliberately left as they were,
  which means these older entries are still kept indefinitely; giving them an
  expiry is a separate decision.

  **Four entries had a category that was not a recognised value** (`EMAIL` on two,
  `membership` on two). No filter or tool could find them. By the owner's decision
  of 13 September 2026 they are corrected in the same upgrade to the value their
  event type records today, each named individually; no other entry that already
  had a category is touched.

  **Who this affects, plainly.** Anyone with Support access still reads every one
  of these entries in full in **Admin → Audit Log**; the Category filter now
  places them by their stored category rather than by a guess, so a few answer to
  a different filter than before (a setup invitation under **Security** rather
  than Account, for example). In **AI Diagnostics** the older entries are now
  correlated by the tool for their category, behind the same permission as new
  entries of that event type — which is more than before, when they were
  correlated by nobody. Whether an older entry appears on, or leaves, a member's
  own activity page as a result was the club owner's decision under the
  repository's rule for it, taken on 13 September 2026: **no older entry leaves a
  member's page.** A bulk deactivation or reactivation recorded before the
  category became mandatory is filed under **Account** — the category that event
  carried at the time — rather than the **Admin** the bulk screen records today,
  so the member keeps sight of their own deactivation, exactly as the owner had
  already decided for that era's categorised entries. A small number of older
  entries appear on a page for the first time, almost all only on the acting
  officer's own; three billing-family selections, two issue reports and one
  nomination replacement become visible to the member they concern. The upgrade
  notes list every group.

  **You will see the upgrade record itself.** One new entry under **Admin**
  carries how many entries had no category before, how many were given one (by
  category and by event type), the four corrections, and how many were left. An
  event type that only a differently-historied deployment holds stays without a
  category — still listed on the Audit Log screen, still outside Diagnostics, and
  disclosed as such. The upgrade runbook asks whoever performs the
  upgrade to run the statement once more after cutover, which picks up anything the
  previous version recorded during the upgrade window; on a deployment already
  running the mandatory-category runtime it finds nothing. The column stays
  optional in the database on purpose — the notes say why.
