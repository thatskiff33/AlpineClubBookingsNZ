- **The booking ledger now records booking edits (#3582).** Every priced
  edit — adding or removing a guest, changing dates, and the combined edit —
  posts its own lines night by night: the nights it took away are reversed,
  the nights it added are posted fresh, with the promotion and any change fee
  alongside, and nothing posts unless those lines add up to exactly what the
  edit charged or refunded. Closing a parked edit's review posts the re-priced
  nights, and the agreed amount is recorded only where the re-price does not
  already record it, so the same money is never counted twice. Nothing reads
  the ledger yet (#3584), so no figure anyone sees changes.
