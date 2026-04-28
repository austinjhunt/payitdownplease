# 💸 Pay It Down Please

> The U.S. Treasury now accepts Venmo donations toward the $36 trillion national debt. We made a simulator. This is fine.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/new)

## What is this?

A satirical web app mocking the U.S. Treasury's decision to accept PayPal/Venmo donations toward the national debt — a program that has raised ~$67M since 1996 against a ~$36 trillion debt growing at $3,860/second.

### Features

- 📈 **Live debt counter** — ticks up in real time at the actual rate
- 💸 **Fake donation simulator** — pick an amount, submit a "donation"
- 🤖 **AI-generated Venmo memos** — powered by Claude Haiku (cheapest, fastest)
- 📜 **Shared live feed** — all patriots see each other's donations (SQLite backend)
- 🏆 **Leaderboard** — top "donors" across all sessions
- 🐦 **Share on X** — flex your contribution percentage
- 🎵 **Sound effects** — a little victory jingle on each donation
- 🎊 **Confetti** — proportional to your donation size

## Stack

- **Backend**: Node.js + Express (minimal, single process)
- **Database**: SQLite via `sql.js` (pure JS, no native build required, file-based)
- **AI**: Anthropic Claude Haiku via REST API (cheapest model, ~$0.0001/memo)
- **Frontend**: Vanilla HTML/CSS/JS served by Express

No build step. No framework. No nonsense.

## Setup

```bash
git clone https://github.com/austinjhunt/payitdownplease.git
cd payitdownplease
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

npm start
```

Open [http://localhost:3000](http://localhost:3000)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API key (optional — app works without it, uses fallback memos) |
| `PORT` | `3000` | Server port |
| `DB_PATH` | `./data/donations.db` | SQLite file path |

## Deployment

### Railway (Recommended — free tier available)
1. Push to GitHub
2. Connect repo at [railway.app](https://railway.app)
3. Add `ANTHROPIC_API_KEY` env var
4. Deploy — Railway auto-detects Node.js

### Render
1. Push to GitHub
2. New Web Service at [render.com](https://render.com)
3. Build: `npm install`, Start: `npm start`
4. Add env vars

### Self-hosted / VPS
```bash
npm install
cp .env.example .env && nano .env
node server.js
# Or with PM2: pm2 start server.js --name payitdownplease
```

## Cost

- **Hosting**: ~$0/mo on Railway free tier or Render free tier
- **Database**: SQLite file, no external DB
- **AI memos**: Claude Haiku at ~$0.0001 per memo — $1 covers ~10,000 AI memos

## The Real Program

The actual "Gifts to Reduce the Public Debt" program has operated since 1961 under 31 U.S.C. § 3113. You can donate at [pay.gov](https://www.pay.gov). As of 2026, the Treasury now accepts PayPal and Venmo. Total raised since 1996: ~$67 million. The debt: ~$36 trillion. Monthly interest: ~$88 billion.

Bless your heart.

## License

MIT — do whatever, just don't actually expect it to help.
