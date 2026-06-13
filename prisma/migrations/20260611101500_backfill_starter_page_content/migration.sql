-- Backfill the starter PageContent rows so existing deployments keep their
-- public pages after this release. The production blue/green deploy runs
-- Prisma migrations but not the seed, and the home route 404s without a
-- "/home" record, so these rows must exist after migrations alone.
--
-- ON CONFLICT DO NOTHING keeps this safe to run on databases where the seed
-- has already created (or an admin has already edited) any of these pages:
-- existing rows are never modified.
--
-- Keep these values in sync with starterPageContent in prisma/seed.ts
-- (enforced by src/lib/__tests__/page-content-starter-backfill.test.ts).
INSERT INTO "PageContent"
  ("id", "slug", "path", "caption", "menuTitle", "title", "headerText", "sortOrder", "contentHtml", "updatedAt")
VALUES
  (
    'starter-page-home',
    'home',
    '/home',
    'Whakapapa, Mt Ruapehu',
    '',
    'Mt Ruapehu Lodge',
    'Our club lodge sits in the Whakapapa ski area on Mt Ruapehu. Book a stay, join the club, and explore New Zealand''s mountains.',
    5,
    '<h2>Welcome</h2>',
    CURRENT_TIMESTAMP
  ),
  (
    'starter-page-about',
    'about',
    '/about',
    'About the Club',
    'About',
    'About',
    'Learn about our club history, values, and alpine community.',
    10,
    '<h2>About the Club</h2>',
    CURRENT_TIMESTAMP
  ),
  (
    'starter-page-join',
    'join',
    '/join',
    'Join the Club',
    'Join',
    'Join',
    'Nomination by two current members, induction process, and membership details.',
    20,
    '<h2>Becoming a Member</h2>',
    CURRENT_TIMESTAMP
  ),
  (
    'starter-page-join-apply',
    'join/apply',
    '/join/apply',
    'Membership Application',
    '',
    'Apply for Membership',
    'Enter your details, nominate two current club members, and we will move your application through nomination confirmation and committee approval.',
    25,
    '{{member-application-form}}',
    CURRENT_TIMESTAMP
  ),
  (
    'starter-page-rules',
    'rules',
    '/rules',
    'Lodge guidelines',
    'Rules',
    'Rules',
    'Lodge rules and expectations for members and guests staying at the lodge.',
    26,
    '<h2>Lodge Rules</h2>',
    CURRENT_TIMESTAMP
  ),
  (
    'starter-page-contact',
    'contact',
    '/contact',
    'Get in touch',
    '',
    'Contact Us',
    'Have a question about the club, the lodge, or booking a stay? Get in touch and we''ll get back to you.',
    27,
    '{{contact-form}}',
    CURRENT_TIMESTAMP
  ),
  (
    'starter-page-committee',
    'committee',
    '/committee',
    'Volunteer leadership',
    'Committee',
    'Committee',
    'The club is run entirely by volunteers. Meet the committee members who keep things going.',
    30,
    '{{committee-members-cards}}',
    CURRENT_TIMESTAMP
  )
ON CONFLICT DO NOTHING;
