- **The member-merge code was reorganised into smaller files, with nothing about
  merging changed (#3128).** Merging two member records behaves exactly as
  before: the same fields combine the same way, the same relations move, and the
  same checks refuse the same merges. This was the largest production file in
  the system, and the parts of it that are lists rather than actions now live in
  four files of their own.
