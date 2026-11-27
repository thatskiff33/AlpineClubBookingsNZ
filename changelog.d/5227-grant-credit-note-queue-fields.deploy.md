## Who

owner

## What to do

Once, after the deploy, run the read-only query given in pull request #5227
against production. If it returns rows, release them with the statement given
there **before** anyone presses Retry on a FAILED row it listed.

## How to check it worked

The query returns no rows.
