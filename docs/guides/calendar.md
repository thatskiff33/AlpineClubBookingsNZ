# Events Calendar

Audience: Operator

## What it is

A club-wide events calendar for meetings, working bees, social events, and
committee video meetings. It shows a Google-style month view and is available in
two places:

- **Admin → Lodge Operations → Calendar** (`/admin/calendar`) — for admins.
- The member **Events** card on the dashboard → **Events Calendar** (`/calendar`)
  — for every logged-in member except organisation accounts (see below).

Both surfaces render the same calendar; what differs is whether the viewer can
change anything.

The calendar is a module: **Admin → Modules → Events calendar**
(`eventsCalendar`). It ships **on**, which is exactly how the calendar behaved
before it had a switch, so nothing changes for a club that wants it. Turning it
off makes `/calendar`, `/admin/calendar`, and the calendar API return **Not
Found**, and removes the **Events** card from the member dashboard. Events
already in the calendar are kept and reappear if you switch it back on.

**Organisation accounts never see the calendar.** An organisation (a school,
scout group, or similar body with its own self-service login) is not a club
member, so it gets no Events card, the calendar pages and the events list answer
**Not Found** for it, and any attempt to add or change an event is refused —
whether the module is on or off.

> **Video meetings are not out-of-the-box.** Creating events and viewing the
> calendar work with zero setup, but the **MiroTalk video meeting** attached to
> an event only connects once you have separately provisioned a self-hosted
> MiroTalk service **and** the WebRTC media path it needs: a STUN/TURN server
> and open UDP ports so members joining from home (off the lodge LAN, behind
> NAT/firewalls) can actually connect. Without TURN, a meeting link may open but
> audio/video will silently fail for remote participants. See
> [Video meetings (MiroTalk)](#video-meetings-mirotalk) → *Production* before
> relying on meetings.

## Who can do what

| Action                  | Organisations | Members (ordinary) | Committee members | Admins |
| ----------------------- | ------------- | ------------------ | ----------------- | ------ |
| View read-only calendar | ❌            | ✅ read-only       | ✅                | ✅     |
| Create an event         | ❌            | ❌                 | ✅                | ✅     |
| Edit an event           | ❌            | ❌                 | ❌                | ✅     |
| Delete an event         | ❌            | ❌                 | ❌                | ✅     |
| Open video-meeting link | ❌            | ❌                 | ✅                | ✅     |

- **Everyone who can log in** sees the calendar, **except organisation
  accounts**. Ordinary members get a read-only view: opening an event shows its
  details with only a **Close** button — no Save or Delete.
- **Organisation accounts** are excluded from every column: no dashboard card,
  no calendar page, no events list. The exclusion is decided in one place
  (`canViewCalendarEvents`) and applied to reading and writing alike, so an
  organisation account that also held a committee assignment still cannot add
  an event.
- **Committee members** may add events only. "Committee member"
  means the member holds at least one **active** committee assignment under an
  active committee role (**Admin → Members → [member] → Committee**, managed on
  the [Committee](committee.md) page). This is the one place a committee
  assignment grants an app privilege — everywhere else it is public contact
  metadata only.
- **Admins** with the **lodge edit** permission may also add, edit, and delete
  events (the calendar sits in the lodge permission area, like Work Parties and
  the Roster). Lodge **view** only is read-only.

The gate is enforced on the server for every create/edit/delete, so the buttons
a member cannot use are never shown — and even a stale page could not save.

> To check why a specific person can or cannot edit, run
> `npm run calendar:diagnose-access -- their@email` — it prints their
> permission matrix, committee assignments, and the final decision.

## Step-by-step

### View the calendar

1. Open **Admin → Lodge Operations → Calendar**, or the **Events** card on the
   member dashboard.
2. Use **‹ ›** to move month to month, **Today** to jump back, and click any
   event chip to see its details. A ↻ icon marks a repeating event; a camera
   icon marks a video meeting.
3. A busy day shows the first few events and a **+N more** link. Click it to open
   that day's full list, then click any event to see its details — so every
   event on a crowded day is reachable, for members and admins alike.

### Create an event

1. Click **New event** (or click an empty day cell).
2. Fill in:
   - **Title** (required).
   - **All-day event**, or a **Date** with **Start time** and optional
     **End time**.
   - **Repeat** (see [Recurring events](#recurring-events) below).
   - **Location** and **Details** (both optional).
   - **Video meeting (MiroTalk)** — tick to attach a meeting link (see
     [Video meetings](#video-meetings-mirotalk)).
3. Click **Create event**.

### Edit or delete an event

1. Click the event, then change fields and **Save changes**, or **Delete**.
2. For a **repeating** event you are asked whether the change applies to **This
   event only** or **All events in the series** — see below.

## Recurring events

Set **Repeat** on an event to make it recur. The options are labelled from the
chosen date:

- **Daily**
- **Weekly on {weekday}**
- **Monthly on day {N}** (e.g. the 15th; clamps to the last day in shorter
  months)
- **Monthly on the {nth} {weekday}** (e.g. the 3rd Tuesday of every month)

You can also set **Repeat every N** (e.g. every 2 weeks) and an **Ends**
condition: **Never**, **On date**, or **After N times**. An open-ended ("Never")
series is generated for about two years ahead (capped at 366 occurrences); pick
an end date or a count for a specific span.

Each occurrence is stored as its own event, so it appears on every month it
falls in and each video meeting gets its own room link.

### Editing one occurrence vs the whole series

When you save or delete a repeating event you choose the scope:

- **This event only** — changes just that occurrence and marks it as an
  exception, so later series-wide edits leave it alone.
- **All events in the series** — applies to every occurrence. Changing the
  details or time updates them all (each keeps its own date); changing the
  **repeat pattern** (frequency, interval, end, or moving the day) rebuilds the
  series from the edited occurrence, preserving any exceptions you made.

When you **delete all events in the series** and some occurrences were edited
individually (exceptions), you choose what happens to them: **Keep
individually-edited events** leaves those occurrences as standalone one-off
events, while **Delete everything** removes the whole series including the
exceptions. Keeping them is the default.

Turning **Repeat** back to **Does not repeat** on a whole-series edit collapses
the series to a single event. Setting **Repeat** on an existing one-off event
converts it into a series.

## Video meetings (MiroTalk)

Ticking **Video meeting (MiroTalk)** on an event attaches a self-hosted
[MiroTalk](https://github.com/miroslavpejic85/mirotalk) meeting. Committee
members and admins then see a **Join meeting** button when they open the event
(and an **Open meeting link** button while editing it) that launches the meeting
in a new tab; ordinary members do not (meetings are for the people running them).

The app never embeds MiroTalk — it links out to it. Each meeting event stores an
unguessable room slug, and the join URL is built server-side each time somebody
clicks Join, so the same event resolves to the right host in each environment.
Without JWT access it uses the shareable path form `…/join/<room>`; with JWT
access it uses MiroTalk's token route `…/join?room=<room>&token=<jwt>` (the only
route that reads the token — the path form ignores it).

### Where each setting lives

**Audience: operator.** Since #2940 the settings a club decides live on
**Admin → Integrations → Video meetings**, and the settings the machine decides
stay in the environment. Nothing was taken away: every environment variable
below still works, and is what the page falls back to until somebody sets a
value on it.

| Setting | Where it lives | Falls back to |
| --- | --- | --- |
| Meeting server address | Admin → Integrations → Video meetings | `MIROTALK_URL`, then `https://meet.<your app domain>` |
| Whoever opens a link is the host | the same page | `MIRO_MEETING_PRESENTER`, then on |
| How long a join link lasts | the same page | `MIRO_JWT_EXP`, then `1h` |
| Signing key | the same page, stored encrypted | `MIRO_JWT_KEY` |
| Host username and password | the same page, stored encrypted | `MIRO_MEETING_USERNAME` / `MIRO_MEETING_PASSWORD` |
| Which hostname the meeting server answers on | `MEET_HOST` (the Caddy `meet` block) | — |
| How Caddy reaches MiroTalk | `MIROTALK_UPSTREAM` | — |

Three rules are worth knowing before you touch either side.

- **Each setting falls back on its own.** Setting the address on the page does
  not strand the signing key in the environment, and vice versa. The page names
  the variable each unset field is reading, so you can always see which half of
  the configuration you are looking at.
- **Nothing is copied from the environment into the club's settings**, ever. A
  value is stored only when an administrator types it and saves, and clearing a
  box hands that setting back to the environment.
- **Moving the address clears the stored host sign-in.** Those three values only
  mean anything to the server they were set for, so they go with it — see
  "Secure, login-free join" below for what that does and does not protect. What
  counts is the address actually **in force**, so typing the address you are
  already using into an empty box, or clearing the box back onto the same
  `MIROTALK_URL`, changes nothing and clears nothing.
- **A value set on the page needs no restart**; it applies the next time
  somebody opens a meeting. A value set in the environment still needs one,
  because that is what changing an environment variable means.

Only a **Full Admin** may change any of it. Any admin who can see the
Integrations hub can read the page, which is the point of it saying where each
value comes from.

### Installing MiroTalk

MiroTalk is a **separate service** you self-host; it is not bundled with this
app. Point the app at it on **Admin → Integrations → Video meetings**, in the
**Meeting server address** box — for example `https://meet.example.org`.

- **An address saved on the page has to be a public `https://` one**, with no
  username or password embedded in it, and it may not be a private, loopback or
  link-local address. A join link carries a signed access token in the address
  itself, and members open it from their own phones and home networks: a
  `localhost` address would resolve on **whoever clicked it**.
- **A bare host is assumed to be `https://`**, so `meet.example.org` is accepted
  and stored as `https://meet.example.org`. Trailing slashes are dropped.
- **`MIROTALK_URL` still works and is what the page falls back to.** It is a
  runtime setting: set it in the app's environment and restart — no rebuild
  required. It is deliberately NOT held to the rules above, so an installation
  that works today keeps working; where its value would not be accepted on the
  page, the page says so and carries on using it.
- **When neither is set, the base is derived from your app's own domain**
  (`NEXTAUTH_URL`) as `https://meet.<domain>` — so a production deploy that
  configured neither points at a real, same-domain host you control (a broken
  `meet.` subdomain is an obvious, fixable error) rather than silently sending
  members to `http://localhost:3010` on **their own** machine. A leading `www.`
  is dropped; if your app runs on another subdomain (e.g.
  `bookings.example.org`) the derived host becomes `meet.bookings.example.org`,
  so set the address explicitly in that case. A **loopback** app host falls back
  to `http://localhost:3010` for local dev.

**Local development (Windows/macOS/Linux with Docker):**

```bash
docker run -d --name mirotalk-p2p -p 3010:3000 \
  -e API_KEY_SECRET=dev-secret-change-me \
  -e JWT_KEY=dev-jwt-change-me \
  mirotalk/p2p:latest
```

Open `http://localhost:3010` to confirm your camera and mic work (WebRTC is
allowed on `localhost` without HTTPS). Leave both the page and `MIROTALK_URL`
unset to use the `http://localhost:3010` default — the page refuses a loopback
address on purpose, so local development goes through the environment fallback —
then create a meeting event and click **Open meeting link**.

**Production (single VM behind Caddy):**

1. Run MiroTalk as its own container on its **own subdomain** — e.g.
   `meet.<yourdomain>` — never iframed into the app (the app's security headers
   block camera/mic and framing on the main domain by design).
2. Reverse-proxy the subdomain through Caddy so it gets a TLS certificate, and
   give that subdomain a `Permissions-Policy` that **allows** `camera` and
   `microphone` (the app's main site deliberately disables them).
3. Tell the app where it is, on **Admin → Integrations → Video meetings**. (Or
   set `MIROTALK_URL=https://meet.<yourdomain>` in the environment and restart,
   which is what installations that predate that page already do.)
4. For members joining from home, run a **TURN server** (MiroTalk bundles
   coturn) and open its ports on the VM firewall (3478 UDP/TCP, 5349), so
   participants behind restrictive networks can connect.
5. For groups larger than ~6–8 people, use **MiroTalk SFU** (`mirotalk/sfu`)
   instead of P2P; it scales better but also needs a UDP media-port range opened
   on the firewall and the VM's public IP announced. See the club's video-meeting
   rollout notes for the SFU specifics.

Keep the MiroTalk image **unmodified** and separate (it is AGPL-licensed); the
app only links to it, which keeps the licence boundary clean.

### Secure, login-free join (JWT tokens)

If your MiroTalk is host-protected (`HOST_PROTECTED=true`, `HOST_USER_AUTH=true`
with `HOST_USERS`), members would normally hit a login prompt. Fill in the
**Host sign-in** section of **Admin → Integrations → Video meetings** and the app
appends a **short-lived signed `?token=`** to each meeting link, so committee
members join straight in while unauthorised people (who never get the link, and
could not forge a token) stay out. The token is minted fresh on each click and
the signing key never reaches the browser.

| Setting | Environment fallback | What it is |
| --- | --- | --- |
| Signing key | `MIRO_JWT_KEY` | Must equal MiroTalk's own `JWT_KEY`, and must be a generated secret of at least 32 characters — see "Choosing the signing key" below. |
| Host username / Host password | `MIRO_MEETING_USERNAME` / `MIRO_MEETING_PASSWORD` | Must match one entry in MiroTalk's `HOST_USERS` (MiroTalk re-checks these). |
| Whoever opens a link is the host | `MIRO_MEETING_PRESENTER` | On (default) = the clicker joins as host so the meeting starts immediately; off leaves joiners on MiroTalk's "waiting for host" screen. |
| How long a join link lasts | `MIRO_JWT_EXP` | `1h` (default), `30m`, `900` (seconds). Between 30 seconds and one day when set on the page. Minted fresh on each click, so this only bounds a link left unopened or forwarded. |

The three sign-in values are stored **encrypted**, in the same place as the
Xero, Stripe and Google credentials, and are never shown again once saved — the
page tells you whether each is set and where it is coming from, never what it
is. **Clear** removes a stored one and hands that setting back to its
environment variable. If two administrators have the page open at once, the
second to save is told somebody changed it first rather than quietly
overwriting them.

**On the MiroTalk side** nothing structural changes — you already have
`JWT_KEY`, `HOST_PROTECTED`, `HOST_USER_AUTH`, and `HOST_USERS`. Just make sure
the app's signing key matches MiroTalk's `JWT_KEY`, and that the host username
and password equal one of your `HOST_USERS` entries. The app reproduces MiroTalk
P2P's exact token format (an AES-encrypted username/password/presenter payload
inside an HS256 JWT), so a matching key is all MiroTalk needs to accept it.

Leave all three unset, in both places, to keep the plain link (MiroTalk shows
its own login prompt).

One consequence worth stating plainly: **the key and the address are a pair.**
The signing key only means anything to the MiroTalk instance that shares it, and
the host username and password have to match one of that instance's `HOST_USERS`
entries. So **changing the meeting server address clears all three stored
values**, and the page tells you it has: they belonged to the old server, and
nobody can read them back out to re-enter them anyway. Set the new server's
values straight afterwards.

If your installation still sets `MIRO_JWT_KEY`, `MIRO_MEETING_USERNAME` and
`MIRO_MEETING_PASSWORD` in the environment, clearing the stored values falls
back to those — which were also set for the old server — so on that installation
the clearing changes little. Clear the environment variables too, or move those
three onto this page, if you want the address and the sign-in to travel
together.

#### Choosing the signing key

The signing key is the whole security of this feature, so it is worth thirty
seconds of care. It does two jobs at once: it signs every join token, and it
encrypts the host username and password that sit inside that token. Anyone who
knows the key can therefore mint a token your MiroTalk accepts **as a host**,
without ever seeing one of your links.

Generate one and use the same value on both sides:

```bash
openssl rand -base64 32
```

- **At least 32 characters, generated — not typed.** A phrase you invented is
  guessable in a way a random string is not.
- **Never keep the value MiroTalk ships** in its own `.env.template`. It is
  published in MiroTalk's repository, so leaving it in place is the same as
  having no key at all. This is the most common way the feature ends up
  insecure, precisely because "make the two match" is the only instruction most
  operators read.
- **Rotate it on both sides together.** They must always be equal; tokens are
  minted per page load, so there is nothing cached to expire.

If the key looks weak — too short, too repetitive, or recognisable as an example
value — the app says so **on the page, to whoever just typed it**, and logs one
warning per key on the server. It **still issues working links** either way.
That is deliberate: a meeting link that silently stopped working would be a
worse failure for the club than a warning nobody has actioned yet. For a key set
in the environment, where there is nobody to tell, grep the container logs for
`meeting signing key` after a deploy to see whether yours tripped it.

## Settings reference

| Field                        | What it controls                       | Default         | Notes / constraints                                     |
| ---------------------------- | -------------------------------------- | --------------- | ------------------------------------------------------- |
| Title                        | The event's display name               | —               | Required; up to 200 characters                          |
| All-day event                | Hides the times; shows on the day only | off             | —                                                       |
| Date / Start time / End time | When the event happens                 | Date required   | End must be on or after start                           |
| Repeat                       | Recurrence pattern                     | Does not repeat | Daily / Weekly / Monthly (day) / Monthly (nth weekday)  |
| Repeat every                 | Interval between occurrences           | 1               | 1–52                                                    |
| Ends                         | When recurrence stops                  | Never           | Never (≈24 months / 366 cap), On date, or After N times |
| Location                     | Free-text location                     | —               | Optional; up to 200 characters                          |
| Details                      | Agenda / notes                         | —               | Optional; up to 5000 characters                         |
| Video meeting (MiroTalk)     | Attaches a meeting link                | off             | Needs a MiroTalk instance, configured on **Admin → Integrations → Video meetings** (see above) |

## Troubleshooting

| Symptom                                               | Likely cause                                                                                    | Fix                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A **Join meeting** link goes to the wrong server, or to `localhost` | Nothing is set on **Admin → Integrations → Video meetings** or in `MIROTALK_URL`, so the address is derived from your app's domain | Open that page: it names the source of every value in force. Set the meeting server address there |
| An address saved on that page **is not being used** | It failed the page's own rules after it was stored (it is `http://`, carries a sign-in, or names a private address) | The page says which rule and what is being used instead; re-enter a public `https://` address |
| A join link lands on MiroTalk's **login** prompt | One of the three host sign-in values is missing, so no token is minted | The page shows which are set and from where. All three are needed — a partial set mints nothing, because MiroTalk would reject it |
| A join link is **rejected** by MiroTalk after it used to work | The signing key and the meeting server no longer match — usually one side was rotated alone | Set the app's signing key to that instance's `JWT_KEY`; they are a pair. Moving the address clears the stored sign-in for you, so after a move it is the three new values that are needed |
| A secret shows **needs re-entering** | It is stored but no longer decrypts, because the app's encryption key changed | Type it again on that page. Until you do, links are unsigned rather than broken |
| **Calendar** and the dashboard **Events** card have vanished for everyone | The **Events calendar** module was switched off | Turn it back on at **Admin → Modules**; your events are still there |
| One person gets **Not Found** on `/calendar` while everyone else is fine | That account is an **organisation**, which never sees the calendar | Confirm with `npm run calendar:diagnose-access -- their@email` (it prints the module switch and the organisation check ahead of the write gates); working as designed, but if they should be a member, change their user type on **Admin → Members → [member]** |
| A member sees **Save**/**Delete** on events           | That account is a lodge-edit admin (only admins can edit or delete; committee members see **New event** but not Save/Delete)      | Confirm with `npm run calendar:diagnose-access -- their@email`; if they should not edit, remove their lodge-edit role     |
| A member should be able to **create** but cannot       | They have no active committee assignment and no lodge-edit role                                 | Add a committee assignment (**Admin → Members → [member] → Committee**) or grant lodge edit                                       |
| A committee member cannot **edit or delete** an event  | Working as designed — committee members are create-only; only lodge-edit admins may edit/delete | Grant the member the lodge-edit admin role if they need to edit or delete events                                                 |
| A repeating event shows on only one month             | The recurrence was not saved (older build)                                                      | Open the event, set **Repeat**, and **Save** (this converts it to a series), or delete and recreate; ensure the app is up to date |
| Saving or deleting says the event was not found        | Someone else deleted that event (or the whole series) while your dialog was open                | Close the dialog and reload the calendar; the event is already gone, so nothing was lost                                          |
| Camera/mic blocked in the meeting                     | MiroTalk is served over plain HTTP (not localhost) or without a camera/mic `Permissions-Policy` | Serve MiroTalk over HTTPS on its own subdomain with camera/mic allowed                                                            |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Committee](committee.md), [Work Parties](work-parties.md),
  [Hut Leaders](hut-leaders.md), [Lodges](lodges.md).
- [Modules](modules.md) — turn the Events calendar module on or off.
- [Access Roles](access-roles.md) — what an organisation account is.
- Reference: [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
