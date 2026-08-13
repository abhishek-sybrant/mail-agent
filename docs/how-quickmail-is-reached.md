# How this app reaches QuickMail

Every operation goes through one of four paths. Which one is never a
preference — it is dictated by what QuickMail exposes, and each step down this
list costs something.

| | Path | Auth | Used for |
|---|---|---|---|
| 1 | **v2 GraphQL API** | API key | Campaigns, leads, steps, schedules |
| 2 | **Internal GraphQL** | signed-in browser session | Replies, sending, stops, block lists, inbox health |
| 3 | **Playwright UI** | signed-in browser session | The campaign trigger, and unpausing a campaign |
| 4 | **Local only** | — | Suppression, classification, approvals, templates |

The rule behind the ordering: use the documented API where one exists; drop to
the internal endpoint only where the API has no equivalent operation at all;
drive the UI only where neither API can do the thing. Each level down is more
fragile and harder to run unattended, so nothing sits at level 2 or 3 for
convenience.

---

## 1. v2 GraphQL API — `api.quickmail.com/v2/graphql`

The documented API. Raw key in the `Authorization` header, 10 requests per 10
seconds. This is the only path that runs with no browser involved, so
everything that can live here does.

**Reads**

| Operation | What it gives us |
|---|---|
| `Campaigns` / `Campaign` | Names, paused state, per-campaign stats |
| `CampaignSteps` | Step positions and variation ids |
| `LeadsPage` | The lead list — 10 per page, hard-capped |
| `emailAccounts` | Sending mailboxes: id, email, authorized, paused |
| `workspaces` | Workspace id |

**Writes**

| Operation | Used by |
|---|---|
| `CreateCampaign` | Campaign create |
| `SetAccounts` | Attaching sending mailboxes |
| `CreateEmailStep`, `CreateWaitStep` | Building the sequence |
| `CreateLeads`, `AddLeads` | Enrolling prospects |
| `UpdateAutomation` | Sending days, hours, timezone |
| `SetPaused` | Opening and closing the campaign window |

**Known limits, which is why levels 2 and 3 exist**

- `leads(first:)` is capped at 10 however many you ask for. A full pass over
  ~50,000 leads is ~4,800 requests, about 80 minutes at the rate limit — which
  is why the lead sync walks a slice per hour and carries a cursor.
- `emailAccounts(first: 100)` silently returns 10. Pagination is explicit for
  the same reason.
- The `Lead` type has **no** company field, and no custom fields. Probed
  directly: `company`, `companyName`, `organization`, `customFields`,
  `attributes`, `website`, `industry`, `city`, `country` all rejected.
- There is no campaign-level pause, and no trigger. `paused` is writable on
  steps only.
- Nothing about replies. No message, thread or conversation type exists.

---

## 2. Internal GraphQL — `next.quickmail.com/graphql`

QuickMail's own front-end endpoint. Introspection is disabled, so every
operation here was recovered by reading their JavaScript bundles — the shapes
are copied from their call sites, not guessed. Their front end defines 326
mutations; we use seven of them, and five queries.

Requests are issued **inside the signed-in page** via `fetch('/graphql')`, so
the cookie, CSRF token and origin all match. Playwright attaches to a browser
over CDP on port 9222 rather than logging in, so no QuickMail password is
stored anywhere.

| Operation | Used for |
|---|---|
| `appComponentsWorkspaceOpportunities` | Listing replies (30/page, `first` not obeyed) |
| `workspaceAppOpportunity` | One thread with message bodies |
| `replyToEmail` | Sending a reply in-thread; also the manager forward |
| `setProspectsAsDoNotContact` | Marking a prospect do-not-contact |
| `cancelProspects` | Stopping their remaining sequence |
| `addDncEmails` / `removeDncEmails` | The blocked-address list |
| `addDncDomains` / `removeDncDomains` | The blocked-domain list |
| `workspaceDncEmailsPagination`, `workspaceDncDomainsPagination` | Reading both lists |
| `accountinboxPagination` | Deliverability: `accredited`, `score`, daily quota |

**Why each of these cannot use the API**

- Replies: the v2 schema has no reply, message or thread type. Every v1 REST
  path was probed too — `/replies`, `/inbox`, `/messages`, `/threads`,
  `/conversations`, `/emails`, `/unibox`, `/activity`, `/events` — all 404.
- DNC: no v2 equivalent.
- Deliverability: v2 reports whether a mailbox is *connected*, never whether
  its mail *lands*. `accredited` exists only here.

**Quirks worth knowing**

- Ids are different namespaces. v2 uses `email_kKXM…` for a mailbox; this
  endpoint uses a number like `198838`. They are not interchangeable — passing
  the v2 id produced "you don't have the permission to inbox".
- `searchFilter` is a JSON *string*, and is effectively required. Omitting it
  returns a 500 HTML error page.
- An invented field also returns 500 HTML, which says nothing about which
  field was wrong — hence copying shapes from the bundle.
- `reply_type` comes back null on nearly everything, so classification is ours.

---

## 3. Playwright UI automation

Clicking the actual web UI. Off unless `QUICKMAIL_UI_AUTOMATION=true`, and it
never throws into campaign creation — a failure degrades to written manual
instructions rather than losing a campaign that was created successfully.

Used for exactly two things, both verified absent from both APIs first:

- **Setting the daily trigger** — how many new leads start per day. No
  mutation exists anywhere.
- **Unpausing the campaign itself** — as distinct from its steps.

v1 REST was checked as well: `/v1/accounts/{id}/campaigns` is a read-only
list; `/triggers`, `/automation`, `/pause`, `/resume`, `/start`, and `PUT`
and `PATCH` on campaigns, all 404.

This is the most fragile path in the system. QuickMail can break it by
changing their front end, so results are always verified through the API
afterwards.

---

## The browser, and where it runs

Levels 2 and 3 both need a signed-in browser. **It runs on the server**, not on
whoever is using the app: `connectOverCDP` dials `127.0.0.1`, which from the
server's point of view is the server. Someone opening the dashboard from
another machine needs no Edge, no Playwright and no QuickMail login.

The server starts that browser itself when it is not running, using a profile
of its own (`.edge-automation`) with extensions disabled. One thing still needs
a person, once: signing in to QuickMail, because no password is stored. The
profile keeps the session afterwards.

Consequence worth stating plainly: the automation always acts as whichever
QuickMail account that browser is signed in as. It does not matter who clicks
or from where.

---

## 4. Local only — never touches QuickMail

| Area | Why it is local |
|---|---|
| Suppression list | Keyed on the address, so re-importing a spreadsheet cannot resurrect someone who asked to stop. Mirrored *into* QuickMail's DNC as well. |
| Reply classification | QuickMail returns `reply_type` null on nearly everything. |
| Approvals | The human-in-the-loop gate; nothing there to sync. |
| Templates | Ours. QuickMail stores copy per step, not as a library. |
| Campaign windows | QuickMail has no start/end date, so the app enforces it by pausing and unpausing steps on a timer. |
| Managers, sync switches | App configuration. |

---

## Which env var switches what

| Variable | Effect |
|---|---|
| `QUICKMAIL_API_KEY` | Level 1. Without it, campaign and lead sync skip. |
| `QUICKMAIL_DRY_RUN` | Absolute lock on every write, at every level. |
| `QUICKMAIL_UI_AUTOMATION` | Enables level 3 at all. |
| `QUICKMAIL_UI_CDP_PORT` | Debug port, default 9222. |
| `QUICKMAIL_BROWSER_AUTOSTART` | Whether the server starts the browser itself. |
| `QUICKMAIL_BROWSER_PROFILE` | Where the automation profile lives. |
| `FORWARD_TRANSPORT` | `quickmail` (level 2) or `smtp` (no browser, needs an app password). |
| `SYNC_LEAD_PAGES`, `SYNC_REPLY_LIMIT` | How much of levels 1 and 2 each hourly pass does. |

---

## What breaks when the browser is unavailable

This is the practical difference between the levels, and it is visible on the
Sync tab every hour:

**Still works** — campaign stats, mailbox list, lead walk, campaign windows,
everything local.

**Stops** — reply pull, reply sending, stopping a prospect, both block lists,
deliverability figures, manager forwarding.

The hourly sync is built around that split: each part is recorded
independently, and a failed reply pull costs the reply pull only. The mailbox
part still returns its list from the API and simply notes that deliverability
went unread.
