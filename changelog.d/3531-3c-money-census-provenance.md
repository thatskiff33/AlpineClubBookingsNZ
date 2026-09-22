- **The money census now shows what the stored night prices are made of, and
  which edits went to a person, month by month (#3531, stage 3 of 3).**
  `npm run booking-money:census` — read-only, one snapshot — adds night rows by
  provenance and guest strands by the edit gate's own verdict (`EXACT`, or the
  cause an edit would park with) per booking-creation month, and every edit
  financial review by cause per month, beside the reconciliation verdicts it
  already reported. The two share one cause vocabulary: what the gate would
  park against what it did park. Run it before and after a deploy and the
  effect of the earlier two stages reads off as one line against another.
