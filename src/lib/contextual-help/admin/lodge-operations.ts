/**
 * Help for the "Lodge Operations" admin section: hut leaders, rosters, chores,
 * work parties, the calendar, the kiosk and the lobby display.
 *
 * Section per the sidebar's `buildAdminNavSections`. Lockers and chores sit here too:
 * both are lodge assets managed on the ground rather than menu entries.
 */
import { entry, help, type HelpEntry } from "../types";

export const adminLodgeOperationsHelpEntries: HelpEntry[] = [
  entry(
    "/admin/hut-leaders",
    help(
      "Hut Leaders",
      "This page assigns hut leaders, monitors gaps, and manages kiosk PIN access for lodge operations.",
      [
        "Review unassigned dates, assign eligible members, and check existing hut-leader coverage.",
        "Reset or issue kiosk PINs only for the correct hut leader.",
        "Use date filters to focus on the operational window that needs coverage.",
      ],
      [
        {
          name: "Assignment date",
          description:
            "The lodge date the hut leader is responsible for.",
        },
        {
          name: "Eligible member",
          description:
            "A member who can be assigned to a hut-leader role for the selected date.",
        },
        {
          name: "PIN",
          description:
            "The kiosk access code used by the hut leader; reset it only when necessary.",
        },
      ],
      [
        "The Staying tab is booking-derived: it lists adult members who hold the standard member (USER) role and have an operational booking overlapping the selected dates. Use the Any member tab for a season-long custodian who has no booking of their own.",
        "An assignment can optionally hold one bed for its whole date range. That takes the bed out of the bookable pool and off the allocation board for every covered night, with no booking anywhere — the custodian is never a guest, never on the chore roster, and never invoiced for the held bed.",
        "The hold covers the start date to the end date inclusive, including the night of the end date itself. Dates that came from the automatic assignment end on a guest's departure day, so trim the end date by one before adding a bed, or the bed stays held for a night after everyone has left.",
        "A member whose only roles are custom (definition-backed) roles cannot be assigned as hut leader. Keep the standard member (USER) role ticked on their account so they stay eligible.",
      ],
      [
        {
          title: "Hold a bed for a season-long custodian",
          details: [
            "Pick the nights the custodian is in residence, then choose them on the Any member tab.",
            "In Hold a bed (optional), choose their bed. Leave it as No bed — role only if they are not sleeping in the lodge.",
            "A bed that already has guests allocated on it, or that another hut-leader assignment holds, is listed with the exact nights that block it — clear those first on the bed allocation page.",
            "If the hold puts the lodge over capacity on any night you are asked to confirm; that can be perfectly correct, because the custodian really is sleeping there. That question also lists any live booking the per-night figures could not count, so read both before confirming.",
            "To hand the bed back later, use Release bed on that assignment's row — it keeps the assignment, its coverage and its kiosk PIN. Change bed opens the picker for that row's own dates, and works on assignments the nightly job created too.",
          ],
        },
      ],
    ),
  ),
  entry(
    "/admin/lockers",
    help(
      "Lockers",
      "Lockers manages lodge locker assignments and availability.",
      [
        "Search for the member or locker before assigning a locker.",
        "Record start/end dates or status changes when a locker changes hands.",
        "Use notes for operational context such as key returns or access issues.",
      ],
      [
        {
          name: "Locker",
          description:
            "The physical locker identifier used at the lodge.",
        },
        {
          name: "Assigned member",
          description:
            "The member currently responsible for the locker.",
        },
        {
          name: "Status",
          description:
            "Shows whether the locker is available, assigned, inactive, or needs follow-up.",
        },
      ],
    ),
  ),
  entry(
    "/admin/roster",
    help(
      "Roster",
      "Roster manages lodge day rosters and printable operational lists.",
      [
        "Select the roster date, review expected guests, and prepare the daily view.",
        "Use print views for lodge handover or offline use.",
        "Check hut-leader coverage and booking state before relying on the roster.",
      ],
      [
        {
          name: "Roster date",
          description:
            "The lodge date being prepared.",
        },
        {
          name: "Guests",
          description:
            "People expected to be staying or arriving around the selected date.",
        },
      ],
    ),
  ),
  entry(
    "/admin/chores",
    help(
      "Chores",
      "Chores configures lodge chore lists, rosters, and guest task assignment behavior.",
      [
        "Create or edit chore definitions before generating rosters.",
        "Check frequency and active flags so chores rotate as intended.",
        "Use roster previews before publishing or printing assignments.",
      ],
      [
        {
          name: "Chore",
          description:
            "The task name and instructions shown to hut leaders or guests.",
        },
        {
          name: "Frequency",
          description:
            "Controls how often the chore should appear in generated rosters.",
        },
        {
          name: "Active",
          description:
            "Controls whether the chore is eligible for future rosters.",
        },
      ],
    ),
  ),
  entry(
    "/admin/lodge",
    help(
      "Lodge Kiosk",
      "Lodge Kiosk settings and tools support arrivals, departures, chores, PIN access, and day-of-lodge operations.",
      [
        "Review kiosk access and current lodge day information.",
        "Use arrivals/departures and roster views to support the hut leader.",
        "Adjust lodge-facing settings only when operational policy changes.",
      ],
      [
        {
          name: "Kiosk PIN",
          description:
            "The access code used for lodge/kiosk workflows.",
        },
        {
          name: "Arrivals and departures",
          description:
            "Guest movement signals for the selected lodge day.",
        },
      ],
    ),
  ),
  entry(
    "/admin/work-parties",
    help(
      "Work Parties",
      "Work Parties manages volunteer work-party events, attendance, and operational details.",
      [
        "Create events with clear dates, capacity, tasks, and contact instructions.",
        "Review attendees and update status as people sign up or cancel.",
        "Use notes for tools, access, safety, or follow-up actions.",
      ],
      [
        {
          name: "Event date",
          description:
            "When the work party occurs.",
        },
        {
          name: "Capacity",
          description:
            "How many volunteers or attendees can join.",
        },
        {
          name: "Tasks",
          description:
            "The work or maintenance items planned for the event.",
        },
      ],
    ),
  ),
  entry(
    "/admin/calendar",
    help(
      "Events Calendar",
      "The club events calendar for meetings, working bees, and committee video meetings. Every member sees it; committee members and admins with lodge edit can add, edit, and delete events, while other members are read-only.",
      [
        "Click a day (or New event) to add an event, and set a Repeat rule for recurring meetings such as the 3rd Tuesday of each month.",
        "When editing a repeating event, choose This event only or All events in the series.",
        "Tick Video meeting (MiroTalk) to attach a join link committee members and admins can open.",
      ],
      [
        {
          name: "Repeat",
          description:
            "Daily, weekly, monthly by day of month, or monthly by nth weekday, with an interval and an optional end (a date or a number of times).",
        },
        {
          name: "Who can edit",
          description:
            "Committee members (an active committee assignment) and admins with lodge edit; all other members are read-only.",
        },
        {
          name: "Video meeting (MiroTalk)",
          description:
            "Attaches a self-hosted MiroTalk room to the event; requires MIROTALK_URL to point at your MiroTalk instance.",
        },
      ],
    ),
  ),
  entry(
    "/admin/lodge-instructions",
    help(
      "Lodge Instructions",
      "Lodge Instructions edits protected instruction documents for hut leaders and lodge readers.",
      [
        "Edit only the instruction document that matches the operational topic.",
        "Use supported text tokens when the instructions need live club values.",
        "Preview or read the protected route after saving important wording changes.",
      ],
      [
        {
          name: "Document",
          description:
            "The opening, closing, or day-to-day instruction record being edited.",
        },
        {
          name: "Body",
          description:
            "Sanitised HTML content shown to authorised lodge readers.",
        },
        {
          name: "Tokens",
          description:
            "Supported placeholders resolved on read surfaces, such as club name or lodge capacity.",
        },
      ],
    ),
  ),
  // Registered at the PREFIX, so every Lobby Display page — the hub, Devices,
  // Templates, the Visual builder, the wizard itself — resolves to this entry.
  // That is the "always-available Help link" the guided setup wizard needs
  // (#2249): the hub's gold setup card disappears once a screen is live, but a
  // club replacing a TV a year later still needs to find the wizard, and the
  // Help panel is the one affordance present on all of those pages.
  entry(
    "/admin/display",
    help(
      "Lobby Display",
      "Lobby Display pairs the TVs in your lodges and authors the boards they show. Three words, two of them stored: a Layout is the skeleton, a Template is a Layout filled in, and a board is what a screen actually shows.",
      [
        "Setting up a screen for the first time, or replacing one? Open the guided setup wizard at /admin/display/setup — it walks the whole path from the module being off to a TV showing the right board, and it can be re-run safely at any time.",
        "Use Devices to pair a screen, swap which board it shows, change its refresh interval, or revoke a screen that has left the building.",
        "Use the Visual builder to compose a board without writing HTML; Layouts and Templates are the advanced, hand-authored equivalents.",
        "Restore built-in boards on the Templates page if the shipped boards are missing — it never runs by itself, and it overwrites anything saved under a reserved built-in key.",
      ],
      [
        {
          name: "Device",
          description:
            "One lobby screen, bound to a lodge. It holds its own token once paired, so pairing survives reboots until you revoke it.",
        },
        {
          name: "Pairing code",
          description:
            "The six characters the screen shows while it waits. You type them into the admin; the screen then claims its own token on its next poll.",
        },
        {
          name: "Board / Template",
          description:
            "What the screen shows. A device bound to no template falls back to the club default board.",
        },
        {
          name: "Lodge display settings",
          description:
            "The per-lodge values boards print through {{config:…}} tokens (Wi-Fi, checkout time, notices) and the guest-name privacy setting.",
        },
      ],
      [
        "The guided setup wizard remembers its position for the WHOLE club, not per admin — two admins running it share one place in the flow. Every step re-checks real state, so a shared position can only change which step opens first.",
        "Everything under Lobby Display is hidden while the Lobby TV display module is off, except the guided setup wizard, whose first step turns the module on.",
        "A value a board asks for but the lodge has not saved renders as a visible placeholder on the wall, so fill the lodge details in before the TV goes up.",
      ],
    ),
  ),
];
