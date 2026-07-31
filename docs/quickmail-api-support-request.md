# QuickMail support request — API v2 gaps and one suspected bug

Workspace **54552** (Sybrant Technologies), Pro plan, API v2.

We drive campaign creation from our own tool against
`https://api.quickmail.com/v2/graphql`. Three things block full automation. The
first is a suspected bug; the other two are missing capabilities.

Every claim below was verified by schema introspection against the live API, not
inferred from documentation.

---

## 1. `setCampaignEmailAccounts` returns HTTP 500 for 5 of our mailboxes

**This one looks like a bug on your side and is the one we would most like
explained.**

The same mutation, same shape, same campaign, differing only in
`emailAccountIds`, succeeds for 5 mailboxes and returns a **500 with an HTML
error page** (not a GraphQL error) for the other 5.

```graphql
mutation SetAccounts($input: SetCampaignEmailAccountsInput!) {
  setCampaignEmailAccounts(input: $input) { clientMutationId }
}
```

```json
{ "input": { "campaignId": "<id>", "emailAccountIds": ["<one id>"], "assign": true } }
```

Fails (500):

- amelia.andrew@leaserush.us
- sharma@delvein.in
- jennifer.lynne1006@gmail.com
- jennifer.lynne@leaserushai.com
- lisa.white@sybrantre.com

Succeeds:

- amelia.andrew94@outlook.com
- ariya.jones@sybranttech.us
- lisa.white03@hotmail.com
- mia.oliver@sybranttech.us

Not yet attempted, so unknown: monica.williams@myleaserush.us.

There is no pattern we can see — the split does not follow provider type
(`gmail` / `outlook` / `custom_imap`), nor `authorized`, nor `paused`; all ten
report `authorized: true` except `amelia.andrew94@outlook.com`, which is one of
the *successful* ones.

**Questions.** Is there server-side state making these five unassignable via
the API? Assigning them in the web UI works. Could the 500 be turned into a
GraphQL error explaining the cause? An HTML 500 is hard to handle
programmatically — we had to read the response as text and scrape `<title>` to
surface anything useful.

---

## 2. Campaign triggers cannot be set via the API

A campaign created through the API shows this warning in the UI, and sends
nothing until it is resolved by hand:

> Set triggers to start leads on the campaign.

Leads sit at `leadStatus.active` (or `available`) indefinitely. Nothing sends,
and **no error is reported** on the campaign, the step, the mailbox or the lead —
`stats` simply stays `null`. The failure is completely silent, which made it
expensive to diagnose.

We confirmed a trigger cannot be expressed through v2. Searching every type,
field, input field and enum in the schema for "trigger" returns nothing.
`UpdateCampaignAutomationInput` covers only the sending window:

```
UpdateCampaignAutomationInput
    campaignId, timeZone, businessDays, timeRanges
```

Your documentation describes "send times **and** triggers to start new leads
each day" as separate things; the API appears to expose the first and not the
second.

**Requests.**

1. A mutation to set a campaign trigger — at minimum the equivalent of "start N
   new leads per day".
2. A readable field on `Campaign` indicating whether a trigger is configured, so
   a tool can warn instead of leaving a campaign silently inert.

---

## 3. A campaign cannot be unpaused via the API

`Campaign.paused` is readable but there is no mutation to set it. The full
mutation list contains no `updateCampaign`, so `name`, `sharing` and `paused`
are immutable after `createCampaign`. `paused` is writable only on individual
steps, via `updateEmailStep` / `updateWaitStep`.

The practical effect: a campaign built entirely through the API still requires
two manual UI actions before it can send — set the trigger, and unpause.

**Request.** A mutation to set campaign-level `paused`, or an `updateCampaign`
mutation covering it.

---

## Smaller notes

These cost us time and would be worth a documentation line each.

- **`CreateWaitStepInput.unit`** accepts `"minutes" | "hours" | "days"`. The
  singular `"day"` returns `Unknown wait time unit: 'day'`. The plural form does
  not appear to be documented.
- **A sequence must end on a wait step.** A campaign whose last step is an email
  accepts leads, moves them to `active`, and never sends — again with no error.
  Every sending campaign in our workspace has an even step count
  (`Email → Wait [→ Email → Wait]`). If this is a real requirement, it is worth
  documenting; if it is not, the silent non-send is a bug.
- **`timeZone` requires an IANA identifier.** A display label such as
  `(GMT-05:00) Eastern Time (US & Canada)` is rejected with
  `Invalid time zone`. Clear once you hit it, but the error arrives after the
  campaign already exists, leaving it with no sending window.
- **Page size is capped at 10** for `leads` and `campaigns`. `first: 100`
  silently returns 10 rather than erroring, which is easy to mistake for "only
  10 records exist" — we initially read 10 of 314 campaigns because of this.
- **`campaigns(archived:)`** excludes archived campaigns when omitted. Worth
  stating explicitly, since totals otherwise disagree with the UI.
- **`Lead` has no company field** on output, though `LeadInputType` accepts
  `companyName`. Is company data retrievable, and is `{{lead.company_name}}` a
  valid merge tag when set this way?

---

## What we are trying to achieve

Create a campaign end to end from our own interface — steps, sequence, leads,
mailboxes, schedule — and have it start sending without anyone opening
QuickMail. Items 2 and 3 are the only blockers; everything else already works.

Happy to supply campaign IDs, request/response pairs or timestamps for any of
the above.
