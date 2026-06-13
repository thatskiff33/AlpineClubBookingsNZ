// Starter editable page content shared by prisma/seed.ts and the
// 20260611101500_backfill_starter_page_content migration. The migration
// duplicates these values as SQL because production deploys run migrations
// without the seed; src/lib/__tests__/page-content-starter-backfill.test.ts
// keeps the two in sync.
export type StarterPageContent = {
  slug: string;
  path: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  sortOrder: number;
  contentHtml: string;
};

export const starterPageContent: StarterPageContent[] = [
  // The home page route ("/") renders the "/home" record and 404s without
  // it, so a starter record must always exist. Seeding is create-if-missing,
  // so content edited in production is never overwritten by a re-run.
  {
    slug: "home",
    path: "/home",
    caption: "Whakapapa, Mt Ruapehu",
    menuTitle: "",
    title: "Mt Ruapehu Lodge",
    headerText:
      "Our club lodge sits in the Whakapapa ski area on Mt Ruapehu. Book a stay, join the club, and explore New Zealand's mountains.",
    sortOrder: 5,
    contentHtml: `<h2>Welcome</h2>`.trim(),
  },
  {
    slug: "about",
    path: "/about",
    caption: "About the Club",
    menuTitle: "About",
    title: "About",
    headerText: "Learn about our club history, values, and alpine community.",
    sortOrder: 10,
    contentHtml: `<h2>About the Club</h2>`.trim(),
  },
  {
    slug: "join",
    path: "/join",
    caption: "Join the Club",
    menuTitle: "Join",
    title: "Join",
    headerText:
      "Nomination by two current members, induction process, and membership details.",
    sortOrder: 20,
    contentHtml: `<h2>Becoming a Member</h2>`.trim(),
  },
  {
    slug: "join/apply",
    path: "/join/apply",
    caption: "Membership Application",
    menuTitle: "",
    title: "Apply for Membership",
    headerText:
      "Enter your details, nominate two current club members, and we will move your application through nomination confirmation and committee approval.",
    sortOrder: 25,
    contentHtml: "{{member-application-form}}",
  },
  // The website footer, terms page, and sitemap link to /rules, so a
  // starter record must exist for the dynamic route to serve.
  {
    slug: "rules",
    path: "/rules",
    caption: "Lodge guidelines",
    menuTitle: "Rules",
    title: "Rules",
    headerText:
      "Lodge rules and expectations for members and guests staying at the lodge.",
    sortOrder: 26,
    contentHtml: `<h2>Lodge Rules</h2>`.trim(),
  },
  {
    slug: "contact",
    path: "/contact",
    caption: "Get in touch",
    menuTitle: "",
    title: "Contact Us",
    headerText:
      "Have a question about the club, the lodge, or booking a stay? Get in touch and we'll get back to you.",
    sortOrder: 27,
    contentHtml: "{{contact-form}}",
  },
  {
    slug: "committee",
    path: "/committee",
    caption: "Volunteer leadership",
    menuTitle: "Committee",
    title: "Committee",
    headerText:
      "The club is run entirely by volunteers. Meet the committee members who keep things going.",
    sortOrder: 30,
    contentHtml: "{{committee-members-cards}}",
  },
];
