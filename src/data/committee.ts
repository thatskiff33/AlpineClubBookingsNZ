export interface CommitteeMember {
  role: string;
  name: string;
  phone: string;
  contactKey?: string; // maps to /contact?recipient=key
  description: string;
}

const committeeMembers: CommitteeMember[] = [
  {
    role: "President",
    name: "Michael Higgins",
    phone: "+64 20 4079 4310",
    contactKey: "president",
    description: "Chairs meetings and oversees club operations.",
  },
  {
    role: "Secretary",
    name: "Sally Woodfield",
    phone: "+64 21 686 020",
    contactKey: "secretary",
    description: "Manages club correspondence and meeting minutes.",
  },
  {
    role: "Treasurer",
    name: "Jordan Hartley-Smith",
    phone: "+64 27 422 4115",
    contactKey: "treasurer",
    description: "Manages club finances, subscriptions, and accounts.",
  },
  {
    role: "Booking Officer",
    name: "Chris Duyvestyn",
    phone: "+64 27 472 1328",
    contactKey: "bookings",
    description:
      "Manages lodge bookings, confirms non-member stays, and handles booking enquiries.",
  },
  {
    role: "Communications Officer",
    name: "Wayne Peterson",
    phone: "+64 21 832 118",
    contactKey: "communications",
    description:
      "Manages club communications, newsletters, and public information.",
  },
  {
    role: "Lodge Maintenance Officer",
    name: "Lance Pilcher",
    phone: "+64 27 699 2688",
    description:
      "Coordinates lodge maintenance, working bees, and improvement projects.",
  },
];

export default committeeMembers;
