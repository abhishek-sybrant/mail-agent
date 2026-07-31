# AI SDR Dashboard

Outbound campaign console for Sybrant, built on top of a live QuickMail
workspace. Campaigns are described in plain language, assembled by an AI agent,
and reviewed by a human before anything sends.

## What it does

- **AI Agent** — describe a campaign in a sentence; the agent extracts the
  schedule, targeting and copy, asks only for what is genuinely missing, and
  assembles the sequence in QuickMail.
- **Dashboard** — send/delivery/bounce/reply metrics across every campaign,
  with a deliverability panel that surfaces campaigns above a 5% bounce rate.
- **Leads** — server-side paginated view of the synced lead database, with
  filtering and CSV/XLSX import.
- **Templates** — approved copy per service line, imported from `.docx` briefs.
  The agent prefers these over generating fresh copy when one matches.
- **AI Inbox** — reply classification and draft responses, human-approved.

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4 ·
shadcn/ui · Prisma 7 on SQLite · Auth.js v5

AI is pluggable per task — Gemini, Anthropic, or a local Ollama model — via
`AI_PROVIDER` and `AI_PROVIDER_<TASK>`.

## Running it

```bash
npm install
cp .env.example .env     # fill in QUICKMAIL_API_KEY, AUTH_SECRET, an AI key
npx prisma migrate dev
npm run dev              # http://localhost:3000
npm run scheduler        # separate terminal — releases scheduled campaigns
```

`npm run scheduler` is not optional for scheduled campaigns. QuickMail has no
campaign start/end date, so this app implements the window itself by pausing and
unpausing email steps; nothing is released while the scheduler is down.

## Safety model

This drives a **live** sending account, so writes are gated:

- `QUICKMAIL_DRY_RUN=true` (the default) blocks every write server-side. The UI
  toggle can only request a live write when the environment already permits it.
- Bounced, suppressed and opted-out leads are never enrolled, whatever is
  selected in the picker.
- Mailboxes that QuickMail reports as deauthorized are refused — they attach
  without complaint and then silently send nothing.
- Campaign creation is previewable: a dry run returns the exact mutation plan.

## QuickMail API limitations

Found by exhaustive introspection of the v2 GraphQL schema (23 mutations, 28
input types) and probing of the v1 REST API. These shape the design:

| Capability | Status |
|---|---|
| Create campaign, steps, leads, mailboxes, send window | supported |
| **Campaign trigger** (starts leads into the sequence) | **not in either API** |
| **Campaign-level pause/unpause** | **readable only, no mutation** |
| Campaign start/end dates | no field — implemented locally |
| `cced` / `bcced` / `preview` / `paused` on a step | writable, *not* readable |

The first two must be done once per campaign in the QuickMail UI. The app
surfaces them as explicit numbered steps with a deep link rather than failing
silently. `scripts/finish-campaign.ts` can automate them via Playwright, off by
default — see `QUICKMAIL_UI_AUTOMATION` in `.env.example`.

Other findings worth knowing: a sequence must **end on a wait step** or it
accepts leads and never sends; `timeZone` requires an IANA id, not a display
label; page size is capped at 10 and `first: 100` silently returns 10; the only
merge tags that resolve are `{{lead.first_name}}` and `{{inbox.signature}}`.

`docs/quickmail-api-support-request.md` writes these up for QuickMail support.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | dev server |
| `npm run scheduler` | releases campaigns at their start time |
| `npm run finish-campaign -- <url>` | set trigger + unpause via the UI (opt-in) |
| `npx tsx scripts/full-sync.ts` | full pull of mailboxes, campaigns and leads |
| `npx tsx scripts/import-templates.ts` | load `.docx` briefs into Templates |
| `npx tsx scripts/fix-merge-tags.ts` | rewrite stored copy to QuickMail tag syntax |

## Rate limiting

QuickMail allows 10 requests per 10 seconds, enforced exactly. The client paces
to just under that using a **cross-process** limiter (a lock file in the temp
directory), because the budget is per API key, not per process — the dev server
and a sync script would otherwise each spend the full allowance and get
throttled. Pacing to the real limit is faster than over-driving it.
