## Who

officer

## What to do

Once, about two and a half hours after the old release has finished draining (the end of the blue/green switchover), open Admin, Email Deliverability and look in Exhausted Email Failures for rows marked "May already have been delivered". Emails still QUEUED that the old release wrote during the blue/green drain, or before this release within the last 7 days, are flagged there and never re-sent automatically; an email the old release had already sent or failed is left alone. A row stranded during the drain is flagged only once it is past the stranded threshold (30 minutes with the default mail settings) and the next 30-minute retry run has passed, so up to about 2 hours 20 minutes after the drain ends with the largest mail timeouts.

The first runs may send a burst of officer alert emails, one per flagged row and at most 50 a run. For each flagged row, check with the recipient whether it arrived, then choose Try again or Archive.

## How to check it worked

No row marked "May already have been delivered" remains unarchived, unless you are still waiting to hear back from its recipient.
