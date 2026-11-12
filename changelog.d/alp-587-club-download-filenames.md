- **The members CSV and the "Download My Data" file are named after the club,
  not `tac-` (#4986 follow-up).** The admin members export is now
  `<club>-members-<date>.csv` and a member's own data export
  `<club>-my-data-<date>.json`, where `<club>` is the club's short name in
  lower case with hyphens (or `club` when it has no usable letters). Both come
  from one shared helper, `clubDownloadFilename`, which the Reports downloads
  are to use too.
