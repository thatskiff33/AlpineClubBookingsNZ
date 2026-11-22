- **Doc links in changelog entries keep working after a release is compiled (#5214).**
  An entry written in `changelog.d/` links a doc the way it works from that
  folder, such as `../docs/guides/club-time.md`. The release compiler copied
  that text unchanged into `CHANGELOG.md` at the top of the repository, where
  the same link pointed outside it, so the links had to be fixed by hand at
  every release. The compiler now rewrites each such link to work from the top
  of the repository, including a link whose text runs onto a second line and
  both links of a picture that is itself a link, and refuses a link that leads
  outside the repository altogether; the entry checks run on every pull
  request refuse it too.

  This only affects people preparing a release; nothing changes for a club's
  site or members. The blue/green migration safety ledger also gains the row
  the #4914 starter privacy policy correction was missing.
