import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";

export interface FaqItem {
  question: string;
  answer: string;
}

export interface FaqSection {
  title: string;
  items: FaqItem[];
}

const faqSections: FaqSection[] = [
  {
    title: "Booking & Stays",
    items: [
      {
        question: "How do I book a stay at the lodge?",
        answer:
          "Members can book directly through this website. Log in, click 'Book a Stay', select your dates and add your guests. The calendar shows available beds for each night. You'll need a current membership subscription to book at member rates.",
      },
      {
        question: "What is the cancellation policy?",
        answer:
          "Refunds are tiered based on how much notice you give. Generally, cancellations 14 or more days before your stay receive a full refund. Between 7 and 14 days you receive a partial refund, and cancellations with less than 7 days' notice receive no refund. The exact tiers are set by the committee and shown on the Club Rules page. Always cancel as early as possible if your plans change.",
      },
      {
        question: "What are the nightly rates?",
        answer:
          "Rates vary by season (Winter and Summer) and by age group (Adult, Youth, Child). Members pay a significantly lower rate than non-member guests. Current rates are shown on the Join page. Non-member guests must be accompanied by a financial member.",
      },
      {
        question: "Can I stay at the lodge as a non-member?",
        answer:
          "Yes, but you must be invited as a guest by a current financial member, who must also be staying at the lodge during your visit. Non-member bookings are subject to a 7-day priority hold: if a member-only booking needs the beds within 7 days of your check-in date, your booking may be bumped. You'll receive immediate notification and a full refund if this happens.",
      },
      {
        question: "How does the non-member priority (bumping) system work?",
        answer:
          "The lodge gives priority to member bookings. When you book as a guest more than 7 days in advance, your booking is held as 'Pending' until 7 days before check-in. If a member needs those beds and the lodge is at capacity, the most recently made non-member bookings are bumped first to free up space. You'll be notified immediately by email and receive a full refund. This system ensures members always have access to the lodge they help maintain.",
      },
      {
        question: "Can I change my booking dates?",
        answer:
          "Yes, members can change their booking dates from the booking detail page, subject to availability. A change fee may apply if you're modifying a booking within the late-notice period. The system will show you the fee before you confirm the change.",
      },
    ],
  },
  {
    title: "Membership",
    items: [
      {
        question: "How do I become a member?",
        answer:
          "Membership is by nomination. You need to be nominated by two existing financial members. Start by visiting the lodge as someone's guest, get to know some members, and ask if they'd be willing to nominate you. See the Join page for the full process.",
      },
      {
        question: "What does membership cost?",
        answer:
          "There is a one-off entrance fee for new members, plus an annual subscription. Subscriptions run April to March and are invoiced through Xero. Family memberships cover all household members at a reduced combined rate. Contact the Treasurer for current fee amounts.",
      },
      {
        question: "When does the membership year run?",
        answer:
          "The membership year runs from 1 April to 31 March. Annual subscriptions are due at the start of each year. Members with unpaid subscriptions lose access to member booking rates until their subscription is paid.",
      },
      {
        question: "How do I reset my password?",
        answer:
          "Click 'Forgot password?' on the login page and enter your email address. You'll receive a password reset link valid for one hour. If you don't receive the email, check your spam folder or contact the Booking Officer.",
      },
    ],
  },
  {
    title: "The Lodge",
    items: [
      {
        question: "What facilities does the lodge have?",
        answer:
          `Waldvogel Lodge at Iwikau Village, Mt Ruapehu sleeps up to ${FALLBACK_LODGE_CAPACITY} guests across 6 rooms. The lodge has a fully equipped communal kitchen, dining area, lounge, drying room, and ski storage. Bedding is provided. The lodge is accessible by 2WD vehicle in summer and requires 4WD or chains in winter snow conditions.`,
      },
      {
        question: "What should I bring?",
        answer:
          "Bring your own sleeping bag or hire one. The lodge provides pillows and mattresses. Pack warm clothing, appropriate footwear for the season, and any personal toiletries. If skiing, you can store your gear in the drying room. Check the weather forecast before your trip — conditions on the mountain can change quickly.",
      },
      {
        question: "How do chore rosters work?",
        answer:
          "Every guest staying at the lodge is assigned a chore to help keep it clean and tidy. The hut leader for the night assigns chores (such as cleaning the kitchen, vacuuming, or tidying bathrooms) based on who is staying. You'll receive an email with your assigned chore. Chores are shared fairly and take around 15–30 minutes. It's how we keep lodge fees affordable for everyone.",
      },
    ],
  },
  {
    title: "Privacy & Account",
    items: [
      {
        question: "What personal data does the club hold about me?",
        answer:
          "The club holds your name, email address, phone number, date of birth, booking history, payment records, and chore assignments. This information is used to manage bookings and club membership. See our Privacy Policy for full details on how your data is collected, stored, and used.",
      },
      {
        question: "How do I update my personal details?",
        answer:
          "Log in and go to your Profile page to update your name, phone number, and date of birth. To change your email address, use the 'Change Email' section on your profile — you'll need to verify the new address. To change your password, use the 'Change Password' option.",
      },
    ],
  },
];

export default faqSections;
