import {
  BOOKING_STATUS_GLOSSARY,
} from "@/lib/contextual-help/booking-status-glossary";
import { buildProfilePathWithReturnTo } from "@/lib/internal-return-path";
import type { HelpPageContent, HelpPageEntry } from "./types";

/**
 * Member-facing help corpus, hand-distilled from the seven member guides in
 * docs/user-guide/*. These are short answers a member reads in-app, not the
 * long-form guides — each entry names its source guide so the two stay in sync.
 * Money is always shown in dollars (the club stores integer cents); dates are NZ
 * date-only lodge nights. No club proper nouns — always "the club".
 *
 * This module is server/test-only by convention: no "use client", and it is only
 * imported by `@/lib/help` (`index.ts`) and the corpus tests.
 */

// The exact profile Family Group deep-link the booking help extras leaf uses
// (src/app/(authenticated)/bookings/[id]/_components/booking-help-extras.tsx,
// which replaced the retired BookingHelpDialog in epic #2094 C2). Imported (not
// hardcoded) so it can never drift from that link.
const PROFILE_FAMILY_GROUP_RETURN_TO_BOOK = buildProfilePathWithReturnTo(
  "/book",
  "family-group",
);

function entry(path: string, content: HelpPageContent): HelpPageEntry {
  return { path, content };
}

// The four booking-wizard step ids, mirrored from
// src/app/(authenticated)/book/_components/types.ts (BookingWizardStep). Used as
// `group` tags on the /book questions so the AI route can scope an answer to the
// step the member is on.
const BOOK_STEP_DATES = "dates";
const BOOK_STEP_GUESTS = "guests";
const BOOK_STEP_REVIEW = "review";
const BOOK_STEP_PAY = "pay";

// Source: docs/user-guide/booking-a-stay.md, docs/user-guide/paying-for-your-stay.md,
// docs/user-guide/waitlist-and-offers.md — keep in sync (see docs/user-guide/README.md)
const bookHelp: HelpPageContent = {
  title: "Book a Stay",
  summary:
    "The booking wizard where you choose your lodge nights, add everyone in your party, review the quote in dollars, and confirm. It runs in four steps: Select Dates, Add Guests, Review & Confirm, and Pay (or Admin Review when a booking needs committee sign-off).",
  actions: [
    "Pick your check-in and check-out dates on the calendar — a stay is counted in NZ lodge nights and the check-out date is your departure morning, so 7 Sept to 9 Sept is two nights.",
    "Add each guest; you are in the party by default and can remove yourself if you are only booking for others.",
    "Review the quote and any provisional-guest note, then continue to payment or admin review.",
  ],
  sections: [
    {
      title: "1. Select Dates",
      details: [
        "Each night on the calendar is colour-coded: Available (more than 15 beds free), Filling (6-15), Nearly full (1-5), and Full.",
        "A small season marker shows which season's rates apply — rates differ by season.",
        "If the nights you want are Full, you can join the waitlist instead of booking.",
      ],
    },
    {
      title: "2. Add Guests",
      details: [
        "A guest who is another member can be added as a member guest (member rate, their own bed held).",
        "A guest who is not a member is a non-member guest (non-member rate).",
        "Tick 'Make this a group trip' if you want other people to book their own beds on the same dates; you choose whether each person pays their own bill or you pay one combined bill.",
      ],
    },
    {
      title: "3. Review & Confirm",
      details: [
        "See your nights, party, and quote in dollars before you commit.",
        "If your stay is far enough out under a Members First hold, your member places are booked and charged now while non-member guests are held provisionally — no bed is reserved for them yet, and their portion is auto-charged around the hold deadline if beds remain.",
        "The 'Only book if my guests can come' choice lets you avoid a member-only place if your guests might be bumped.",
      ],
    },
    {
      title: "4. Pay (or Admin Review)",
      details: [
        "If money is due and you pay by card, the Pay step takes payment inside the wizard.",
        "If you close the wizard before paying it is safe: your booking page keeps a Complete Payment card and a 'Payment required' banner.",
        "If the booking needs committee sign-off, step 4 reads Admin Review and no payment is taken until it is approved.",
      ],
    },
  ],
  questions: [
    {
      q: "How do I pick my nights?",
      a: "Choose your check-in date then your check-out date on the calendar. Nights are NZ date-only lodge nights, so 7 Sept to 9 Sept is two nights (the 7th and the 8th).",
      group: BOOK_STEP_DATES,
    },
    {
      q: "The nights I want are full — what now?",
      a: "A Full night cannot be booked. The wizard offers to add you to the waitlist instead, and if a bed frees up the club emails you an offer to accept before it expires.",
      group: BOOK_STEP_DATES,
    },
    {
      q: "How do I add someone who is not a member?",
      a: "Add them as a non-member guest, which uses the non-member rate. If their name matches a bookable person in your family group, the wizard may offer a one-click 'Add as member guest' suggestion at the member rate.",
      group: BOOK_STEP_GUESTS,
    },
    {
      q: "A family member is missing from the quick-add list.",
      a: "Add or invite them in your profile Family Group section, then return to the booking flow and they will appear.",
      link: {
        href: PROFILE_FAMILY_GROUP_RETURN_TO_BOOK,
        label: "Open Family Group in your profile",
      },
      group: BOOK_STEP_GUESTS,
    },
    {
      q: "Why are my non-member guests shown as provisional?",
      a: "Your club runs the Members First policy and your stay is far enough out that a hold applies. Your member places are booked and charged now; the non-member portion is charged around the hold deadline if beds remain, otherwise those guests are bumped and your own place stands.",
      group: BOOK_STEP_REVIEW,
    },
    {
      q: "What does 'Only book if my guests can come' do?",
      a: "It stops you being left with a member-only place if your provisional non-member guests are bumped at the hold deadline — the whole booking only stands if their beds are secured.",
      group: BOOK_STEP_REVIEW,
    },
    {
      q: "How do I pay?",
      a: "Choose card or internet banking on the Review step. Card payments are then taken in the wizard's Pay step, or later from the Complete Payment card on your booking page. Internet banking (where your club offers it and your stay is far enough ahead) raises an emailed Xero invoice instead.",
      group: BOOK_STEP_PAY,
    },
    {
      q: "I closed the wizard before paying — did I lose the booking?",
      a: "No. The booking is kept and your booking page shows a Complete Payment card and an amber 'Payment required' banner so you can finish paying later.",
      group: BOOK_STEP_PAY,
    },
  ],
};

// Source: docs/user-guide/waitlist-and-offers.md,
// docs/user-guide/changing-or-cancelling-a-booking.md — keep in sync (see docs/user-guide/README.md)
const bookingsListHelp: HelpPageContent = {
  title: "My Bookings",
  summary:
    "Your bookings live here, sortable by start date and filterable by status. Waitlist entries and offers also appear here — a later offer shows as 'Waitlist Offered'. Open any booking to change or cancel it.",
  actions: [
    "Sort by start date or filter by status to find a booking.",
    "Open a booking to see its guests, payment state, and available actions.",
    "Act on a 'Waitlist Offered' entry before the offer expires.",
  ],
  questions: [
    {
      q: "How do I join the waitlist?",
      a: "In the booking wizard, choose the nights you want; if they are Full, the wizard offers to add you to the waitlist. On a multi-lodge club you can also opt into alternate lodges so an offer can come from another lodge that frees up.",
    },
    {
      q: "I got a waitlist offer — what do I do?",
      a: "Open the entry showing 'Waitlist Offered' and accept it before it expires. If it lapses, the place can pass to the next person on the list, though you keep your place in line for the next opening.",
    },
    {
      q: "Why is the offered price different from what I expected?",
      a: "It is a cross-lodge offer at a lodge whose rates differ from your original choice. The offer names the lodge and its price and asks you to confirm explicitly; accepting books a fresh entry at that lodge.",
    },
    {
      q: "How do I change or cancel a booking?",
      a: "Open the booking from this list. You can change its dates, guests, or promo code (some nights are locked close to check-in and may need club review), or cancel it — the booking's Page guide shows the refund schedule before you start.",
    },
  ],
};

// Source: docs/user-guide/changing-or-cancelling-a-booking.md,
// docs/user-guide/paying-for-your-stay.md,
// docs/user-guide/being-added-to-a-booking.md — keep in sync
// (see docs/user-guide/README.md)
const bookingDetailHelp: HelpPageContent = {
  title: "Your booking",
  summary:
    "Everything about one booking: its status, guests, payment, and the actions to change or cancel it. The booking page is always the live source of truth if a confirmation, payment, or cancellation email goes missing.",
  actions: [
    "Read the status badges to see where the booking and its payment stand.",
    "Use Complete Payment to pay by card or internet banking if money is still due.",
    "Open this page's guide (Help → Page guide) before cancelling to see the refund schedule that applies to you.",
  ],
  sections: [
    {
      title: "Booking status glossary",
      details: BOOKING_STATUS_GLOSSARY,
    },
    {
      title: "Cancelling and refunds",
      details: [
        "This page's guide shows the cancellation refund schedule once a payment has been captured, so you see the consequence before you start.",
        "Whether you get money back, and how much, depends on how close to check-in you cancel and your club's policy.",
        "A paid booking refunds to your card or as account credit per the schedule; an unpaid but cancellable booking simply shows 'no payment received, no refund'.",
      ],
    },
    {
      title: "Ways to pay",
      details: [
        "Card (Stripe): charged immediately; the booking is confirmed on success.",
        "Internet banking: the club emails a Xero invoice; pay by transfer using the reference on it, and your bed is held under the club's lead-time rules.",
        "Account credit from an earlier cancellation is applied toward what you owe; your balance shows on your profile.",
      ],
    },
  ],
  questions: [
    {
      q: "What do the status badges mean?",
      a: "Each badge is a booking state — for example Confirmed (Unpaid) means a pay-on-account booking whose lodge is reserved while the emailed Xero invoice is outstanding, and Bumped means a guest was displaced when capacity changed. The full glossary is in this page's help.",
    },
    {
      q: "A family member is missing from the quick-add list — how do I add them?",
      a: "Add or invite them in your profile Family Group section, then return to the booking flow.",
      link: {
        href: PROFILE_FAMILY_GROUP_RETURN_TO_BOOK,
        label: "Open Family Group in your profile",
      },
    },
    {
      q: "Will I get a refund if I cancel?",
      a: "Open this page's guide (Help → Page guide) to see the refund schedule that applies before you cancel. A paid booking refunds to your card or as account credit depending on how close to check-in you cancel and your club's policy; an unpaid booking has nothing to refund.",
    },
    {
      q: "Do I get money back on my card or as account credit?",
      a: "It depends on how the booking was paid and your club's settings. Account credit shows in the Account Credit section of your profile and is applied toward what you owe on a future booking.",
    },
    {
      q: "I paid but it still says 'Payment required'.",
      a: "The card step was probably interrupted before payment finished. Open the booking and retry from the Complete Payment card.",
    },
    {
      q: "Another member added me to this booking — do I have to answer?",
      a: "No. The consent card near the top of the page lets you say Yes, add me or No thanks, and a bed is held for you in the meantime — but if you do nothing the request simply lapses at the answer-by date, the bed is released, and the person who made the booking is told. Saying no releases the bed straight away. If the card says only the booking's owner or the club can take you off (for example you are the only guest, or the booking was priced by hand), ask them.",
    },
  ],
};

// Source: docs/user-guide/your-account.md, docs/user-guide/managing-your-family.md
// — keep in sync (see docs/user-guide/README.md)
const profileHelp: HelpPageContent = {
  title: "Your profile",
  summary:
    "One page for your login and personal details, your family group, and your account credit. It holds your account information, security (password, two-factor, connected accounts), personal details synced with the club's accounting, notification preferences, and your privacy and data rights.",
  actions: [
    "Change your email or password, or set up two-factor authentication, in the Security section.",
    "Manage your household in the Family Group and Partner sections — changes go to the club for review before they take effect.",
    "Turn optional emails on or off in Notification Preferences; essential booking emails are always sent.",
  ],
  sections: [
    {
      title: "Your account and sign-in",
      details: [
        "Account Information shows your membership type, status, age tier, and subscription state — your subscription status decides whether you book at member rates.",
        "Change Email sends a verification link to the new address; the change only takes effect after you click it.",
        "Two-factor authentication and, where the club enables them, an email sign-in link or linked Google account are all managed in Security.",
      ],
    },
    {
      title: "Family and household",
      details: [
        "Request to join a family group by another member's email, or create your own with an optional partner and infant/child/youth rows — the whole bundle goes to the club for review first.",
        "Login-capable adults confirm their own inclusion; dependents (infants, children, youth) have no login and are managed by the group's adults.",
        "Record one partner by email in the Partner section; they confirm from their own profile, and each member can have at most one confirmed partner.",
      ],
    },
    {
      title: "Privacy and account credit",
      details: [
        "Account Credit shows any balance from a cancelled paid booking, applied toward what you owe next time.",
        "Download My Data gives you a JSON copy of your data, capped to a few downloads per day.",
        "Request Account Deletion is reviewed by an admin and is irreversible on approval — you are anonymised and future bookings are cancelled.",
      ],
    },
  ],
  questions: [
    {
      q: "How do I change my email or password?",
      a: "In the Security and Change Email sections of your profile. A password change applies immediately and must meet the club's live policy; an email change only takes effect after you click the verification link sent to the new address.",
    },
    {
      q: "How does family billing work?",
      a: "You group your household so you can book and be billed together. Who pays for the household is set by the club; you manage the group itself from the Family Group section, and changes go to the club for review before they take effect.",
    },
    {
      q: "How do I add a child or record a partner?",
      a: "Add an infant, child, or youth as a dependent through your family group (no login is created for them). Record a partner by entering their email in the Partner section; they confirm from their own profile.",
    },
    {
      q: "Which emails can I turn off?",
      a: "Optional emails like Check-in Reminders, Chore Roster, and Club Communications. Essential booking emails — Booking Confirmations, Booking Updates, and Cancellation Notices — are always sent and cannot be turned off.",
    },
    {
      q: "How do I download my data or delete my account?",
      a: "Use the Privacy & Data section. Download My Data gives a JSON export capped to a few per day; Request Account Deletion is reviewed by an admin and is irreversible on approval.",
    },
  ],
};

// Source: docs/user-guide/booking-a-stay.md, docs/user-guide/joining-the-club.md
// — keep in sync (see docs/user-guide/README.md)
const dashboardHelp: HelpPageContent = {
  title: "Your dashboard",
  summary:
    "Your home base after signing in. Its cards — Upcoming Bookings, Next Stay with a lodge-occupancy meter, Account Credit, Payment Owed, and Recent Bookings — link you into the main member journeys.",
  actions: [
    "Start a new stay from Book in the top navigation.",
    "Open My Bookings to see, change, or pay for existing bookings.",
    "Open your profile to manage your details, family group, and account credit.",
  ],
  questions: [
    {
      q: "How do I book a stay?",
      a: "Click Book in the top navigation to open the booking wizard, then pick your nights, add your guests, review the quote, and pay. You need your membership subscription paid up to book at member rates.",
    },
    {
      q: "Where do I see my existing bookings?",
      a: "In My Bookings, sortable by start date and filterable by status. Your Next Stay card on the dashboard also shows a 'how full for your dates' occupancy meter.",
    },
    {
      q: "I have just joined — what can I do here?",
      a: "Once your application is approved and you have set your password, you land here after signing in. From the dashboard you can make your first booking, complete your profile, and check your subscription status.",
    },
    {
      // #2779. The dashboard draft card is where a member first meets a booking
      // the club made for them, and it is the only door left open to a member
      // whose unpaid subscription blocks them from booking.
      q: "There is a draft booking here that I did not make — what is it?",
      a: "The club can make a booking on your behalf and leave the payment to you. It shows in Draft Bookings labelled 'Saved for you by the club' with a Review & pay button — open it, check the details, and pay; paying confirms it. This works even while an unpaid subscription is stopping you starting a booking of your own. Unpaid drafts are removed 72 hours after they are saved, so do not leave it. If the booking comes to $0 there is nothing to pay and the club confirms that one for you.",
    },
  ],
};

// No dedicated member guide covers induction — generic-safe content only
// (defers to the club's own wording; nothing to sync against).
const inductionHelp: HelpPageContent = {
  title: "Induction",
  summary:
    "Your lodge induction sign-offs — the acknowledgements the club needs before you use the lodge. Review any outstanding induction and complete its sign-off.",
  actions: [
    "Read the induction content in full before signing off.",
    "Complete the sign-off to record your acknowledgement.",
    "Contact the club office if an induction you expected is missing.",
  ],
  questions: [
    {
      q: "What is a lodge induction?",
      a: "A short set of instructions and safety information the club asks you to read and acknowledge. Completing the sign-off records that you have read it.",
    },
    {
      q: "How do I complete an induction?",
      a: "Open the outstanding induction, read it in full, and complete its sign-off. If one you expected is not shown, contact the club office.",
    },
    {
      q: "Why does the club need this?",
      a: "It records that you understand how to use the lodge safely before your stay. The wording is set by the club.",
    },
  ],
};

// No dedicated member guide covers lodge instructions — generic-safe content
// only (defers to the club's own documents; nothing to sync against).
const lodgeInstructionsHelp: HelpPageContent = {
  title: "Lodge instructions",
  summary:
    "The club's opening, closing, and day-to-day lodge instruction documents for members and lodge readers. Read the document that matches what you need to do at the lodge; you can print it for use offline.",
  actions: [
    "Choose the opening, closing, or day-to-day document you need.",
    "Read it in full before you rely on it at the lodge.",
    "Use the print view when you need a copy offline.",
  ],
  questions: [
    {
      q: "Which document do I read?",
      a: "Choose the one that matches your task — opening the lodge, closing it, or day-to-day use. The wording is maintained by the club.",
    },
    {
      q: "Can I use these offline?",
      a: "Yes. Use the print view to keep a copy for when you are at the lodge without a connection.",
    },
    {
      q: "The instructions look out of date.",
      a: "Contact the club office. The documents are maintained by the club and only lodge readers see the current version here.",
    },
  ],
};

// Source: docs/user-guide/README.md (member-guide index) — keep in sync
// (see docs/user-guide/README.md)
export const memberFallbackHelp: HelpPageContent = {
  title: "Member help",
  summary:
    "This member page is part of the booking and account journeys. Use the page heading, the top navigation (Book, My Bookings, Profile), and any on-page buttons to find what you need. The booking page is always the live source of truth if an email goes missing.",
  actions: [
    "Use the top navigation to reach Book, My Bookings, or your Profile.",
    "Open a booking or profile section for the smallest action that completes your task.",
    "Contact the club office if something looks wrong that you cannot fix yourself.",
  ],
  questions: [
    {
      q: "How do I book a stay?",
      a: "Sign in and click Book in the top navigation, then pick your nights, add guests, review the quote in dollars, and pay. Member rates need your subscription paid up.",
    },
    {
      q: "Where do I manage my account or family?",
      a: "On your profile, reached from Profile in the top navigation. It holds your login and personal details, your family group, notification preferences, and your privacy rights.",
    },
    {
      q: "An email never arrived — what do I do?",
      a: "Check your spam folder first. The booking page always shows the true current state of a booking even if a confirmation, payment, or cancellation email goes missing.",
    },
  ],
};

// Source: docs/user-guide/the-message-board.md — keep in sync (see docs/user-guide/README.md)
const messageBoardHelp: HelpPageContent = {
  title: "Message Board",
  summary:
    "A board the members write themselves — a road report, a reminder, an offer of a lift. A post stays inside your own club unless you tick Share with all clubs; posts other clubs have shared appear here on shaded cards. The newest few posts also appear on your dashboard.",
  actions: [
    "Write into the box at the top and click Post; it appears straight away with your name on it.",
    "Use 'Older posts' at the bottom to move back through the board, and 'Back to the latest' to return.",
    "Ask a club administrator if you need a post of yours hidden or removed.",
  ],
  questions: [
    {
      q: "Who can see what I post?",
      a: "Every signed-in member of your own club — and, only if you tick 'Share with all clubs' before posting, members of the other clubs on the network, who see it with your name and your club's name on it. Untick is the default, and if sharing is not set up for your club the tickbox says so and every post stays here.",
    },
    {
      q: "Can I edit or delete my own post?",
      a: "No. Ask a club administrator, who can hide it — which is reversible and keeps the text — or remove it, which deletes the words permanently.",
    },
    {
      q: "Why can I not find the message board?",
      a: "Your club has not switched the Message board module on. Your club administrator can turn it on.",
    },
    {
      q: "Can I post under a different name?",
      a: "No. Your name is taken from your member record when you post, not from anything you type, so a post is always attributed to the person who wrote it.",
    },
    {
      q: "Why was my post refused?",
      a: "Posts are limited to ten an hour per member, and to 4000 characters. The counter under the box shows how much you have used. The limit is far above ordinary use — it is there so one person cannot fill the board.",
    },
    {
      q: "Will formatting or links work?",
      a: "Yes — the toolbar offers headings, bold, italic, underline, a fixed set of colours and sizes, alignment, lists and pictures. The colours on offer are the whole menu, chosen to stay readable on both themes. Pictures have their location data removed on upload, so a photo does not publish where it was taken.",
    },
  ],
};

export const memberHelpEntries: HelpPageEntry[] = [
  entry("/book", bookHelp),
  entry("/bookings", bookingsListHelp),
  entry("/bookings/*", bookingDetailHelp),
  entry("/profile", profileHelp),
  entry("/dashboard", dashboardHelp),
  entry("/message-board", messageBoardHelp),
  entry("/induction", inductionHelp),
  entry("/lodge-instructions", lodgeInstructionsHelp),
];

// Re-exported for the /book group-tag test seam.
export const BOOK_WIZARD_STEP_IDS: readonly string[] = [
  BOOK_STEP_DATES,
  BOOK_STEP_GUESTS,
  BOOK_STEP_REVIEW,
  BOOK_STEP_PAY,
];
