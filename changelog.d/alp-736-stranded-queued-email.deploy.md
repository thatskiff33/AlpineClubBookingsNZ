## Who

officer

## What to do

Once, in the first hour after the deploy, open Admin, Email Deliverability and look in Exhausted Email Failures for rows marked "May already have been delivered". QUEUED emails written by the old release during the blue/green drain, or before this release within the last 7 days, are flagged there and never re-sent automatically. For each one, check with the recipient whether it arrived, then choose Try again or Archive.

## How to check it worked

No row marked "May already have been delivered" remains unarchived, unless you are still waiting to hear back from its recipient.
