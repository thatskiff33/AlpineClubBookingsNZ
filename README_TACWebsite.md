# Tokoroa Alpine Club Website

Official website for **Tokoroa Alpine Club Incorporated** — a New Zealand alpine club established in 1969 to encourage tramping, mountaineering, climbing, skiing, and alpine activities.

## About

The Tokoroa Alpine Club operates a lodge on Mt Ruapehu (Whakapapa area) that accommodates up to 29 people. The lodge is available year-round for members and guests, serving winter sports enthusiasts, trampers, photographers, families, and school groups.

This project is a rebuild of the club's website (previously WordPress at tokoroa.org.nz), now combined with the [TACBookings](https://github.com/thatskiff33/TACBookings) lodge booking system into a single modern web application.

## Website Pages

- **Home** — Club introduction and key links
- **About the Club** — History, objectives, and lodge information
- **Join the Club** — Membership types and fees
- **Club Rules & Info** — Membership classes and lodge booking rules
- **Committee** — Current committee members
- **Bookings** — Online lodge booking system (replacing CheckFront)
- **Contact** — Contact form and club details

## Hosting

Hosted on **AWS Lightsail** with:
- Linux instance running Nginx
- SSL via Let's Encrypt
- Deployment via GitHub Actions

## Development

See [CLAUDE.md](./CLAUDE.md) for the full build plan, site research, and implementation details.

### Getting Started

```bash
# Clone the repository
git clone https://github.com/thatskiff33/TACBookings.git

# Install dependencies
npm install

# Start development server
npm run dev
```

_Development commands will be finalised once the TACBookings codebase is reviewed and expanded._

## Affiliations

- [Federated Mountain Clubs (FMC)](https://www.fmc.org.nz/)
- [Ruapehu Mountain Clubs Association (RMCA)](https://rmca.org.nz/)
- [Facebook](https://www.facebook.com/TokoroaAlpineClub/)

## License

Private — Tokoroa Alpine Club Incorporated.
