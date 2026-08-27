- **How a membership season is named now reads the same everywhere, and it
  changes what members see on three pages and in the data they download
  (#3103).** A season that used to read `2026/2027` now reads
  `2026 - 2027 (Apr-Mar)` on a member's profile page, everywhere on an admin's
  member page — the seasonal-membership card, the membership summary tile, the
  subscription history table and the collapsed membership summary line — and in
  the roll-forward summary on the membership-types page. The same wording now
  appears in the season label of the file a member gets from "Export my data".

  Members will notice. Nothing about their membership, their subscription or
  what they owe has changed — only the words the season is written in. A file a
  member downloaded before this release will name the same season the old way,
  and one they download afterwards will name it the new way; nothing already
  downloaded is altered, because the club's system never reads those files back.

  The export's structure is unchanged. It carries the same fields it always did,
  in the same order and of the same types, and the machine-readable `seasonYear`
  number beside the label is untouched — so anything reading the export by that
  number sees no difference at all. Only the wording of the `seasonLabel` text
  changed.

  The reason for the change is that each of those four places wrote the season
  name out by hand as "this year slash next year", which quietly assumes every
  club's season runs across two calendar years. That is true for a club whose
  financial year ends in March, and false for one whose year ends in December —
  its season runs January to December, one calendar year, and the old wording
  would have named a season "2026/2027" that was entirely inside 2026. All four
  now ask the same shared rule, which works the answer out from the club's
  configured financial year-end.

  Two things this deliberately does not do. Invoice lines, credit-note
  descriptions and Xero activity labels keep the old wording, because a
  re-issued historical membership charge has to reproduce its invoice line
  exactly or the club's reconciliation stops matching; those need their own
  decision and are not swept in here.

  And for a club whose financial year does not end in March, none of these four
  places reliably shows the new wording yet. The club's year-end month is read
  once per server process and is not read at all by a page rendered in the
  browser, so all four can still fall back to March. What every one of them now
  does guarantee is that the season's NAME and the season it is naming come from
  the same answer, so a club can never be shown a name that contradicts the
  season beside it — and a member's screen and their download always say the
  same thing, which is what this change was asked for. Getting the club's real
  year-end all the way to these places is separate work, tracked on its own.
