# Tokoroa Alpine Club Website - Build Plan

## Project Overview

Rebuild the Tokoroa Alpine Club website (currently WordPress at tokoroa.org.nz) as a modern web application, integrated with the TACBookings app. The final product is a single codebase combining the public website and lodge booking system, hosted on AWS Lightsail.

**Repository strategy:** Expand the [TACBookings](https://github.com/thatskiff33/TACBookings) repo (TypeScript) to include the full website. This repo (TAC_Website) contains the build plan and research.

---

## Current Site Research

### Site Structure (7 pages)

| Page | Route | Content |
|------|-------|---------|
| Home | `/` | Hero/landing page, club introduction, key navigation links |
| About the Club | `/about` | Club history, objectives, lodge information |
| Join the Club | `/join` | Membership types, fees, family rates |
| Club Rules & Info | `/rules` | Membership classes, lodge booking rules |
| Committee | `/committee` | Current committee members and roles |
| Bookings | `/bookings` | Lodge booking system (TACBookings integration) |
| Contact | `/contact` | Contact form, club contact details |

### Club Information

- **Established:** 1969
- **Purpose:** Encourage tramping, mountaineering, climbing, skiing, and alpine activities in New Zealand
- **Lodge:** Mt Ruapehu (Whakapapa area), accommodates 29 people
- **Lodge history:** Built over one weekend — floor on Friday 21/3/69, lodge on Saturday, roof on Sunday. Built and maintained entirely by member voluntary labour.
- **Lodge fees:** Among the lowest on the mountain
- **Users:** Winter sports enthusiasts, photographers, trampers, family parties, school groups

### Membership

- Family membership encouraged (cheaper than equivalent individual memberships)
- Concessions for dependent children under 13
- "Reserved Membership" discontinued since May 2000

### Bookings System (replacing CheckFront with TACBookings)

**Current CheckFront features to replicate:**
- Member accounts with online booking and instant availability view
- Paid member bookings immediately confirmed
- Members can change/cancel bookings up to 14 days before stay
- Non-member bookings reviewed 2 weeks out, confirmed by Booking Officer if available
- Payment via Stripe

### Committee Contacts

- Booking Officer: Chris Duyvestyn
- Communications Officer: Wayne Peterson

### Affiliations

- Federated Mountain Clubs (FMC)
- Ruapehu Mountain Clubs Association (RMCA)
- Facebook: facebook.com/TokoroaAlpineClub

---

## Implementation Plan

### Phase 1: Expand TACBookings with Website Pages
1. Review existing TACBookings codebase (stack, routing, components, layout)
2. Add shared layout (header navigation, footer) wrapping all pages
3. Create the 6 content pages (Home, About, Join, Rules, Committee, Contact)
4. Populate with content from current WordPress site

### Phase 2: Design & Styling
1. Alpine/mountain theme appropriate for the club
2. Responsive design (mobile, tablet, desktop)
3. Consistent navigation between website pages and booking system

### Phase 3: AWS Lightsail Deployment
1. Provision Lightsail instance ($5/mo Linux + Nginx recommended)
2. Configure SSL via Let's Encrypt for tokoroa.org.nz
3. Set up GitHub Actions deployment pipeline
4. Configure DNS to point tokoroa.org.nz to Lightsail instance

### Phase 4: Testing & Go-Live
1. Test all pages and booking flows
2. Test responsive design on mobile devices
3. DNS cutover from WordPress host to Lightsail
4. Verify SSL, redirects, and full functionality

---

## Development Commands

_To be updated once TACBookings stack is reviewed._

```bash
# Example (adjust based on actual stack)
npm install          # Install dependencies
npm run dev          # Start development server
npm run build        # Production build
npm run start        # Start production server
```

## Conventions

- TypeScript throughout
- Follow existing TACBookings code patterns and conventions
- Keep content text in page components (no CMS needed for this scale)
- Use environment variables for secrets (Stripe keys, DB credentials, etc.)
