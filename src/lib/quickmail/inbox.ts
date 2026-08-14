import { chromium, type Browser, type Page } from "playwright";
import {
  CDP_PORT,
  ensureDebuggableBrowser,
  serverLabel,
} from "./browser";

/**
 * Reads real inbound replies out of QuickMail, and sends real replies back.
 *
 * WHY THIS ISN'T THE PUBLIC API
 * -----------------------------
 * It cannot be. Checked against the live account by scripts/probe-replies.ts:
 *
 *   v2 GraphQL — 13 query fields, 24 mutations. Replies exist only as counts
 *                (CampaignStats.replies / repliesPositive / repliesNegative).
 *                No message body, no thread, no send.
 *   v1 REST    — every reply-shaped path 404s.
 *
 * QuickMail's own web app has all of it, at an internal endpoint
 * (next.quickmail.com/graphql) whose operations were read out of their JS
 * bundle rather than guessed — see scripts/capture-quickmail-mutations.ts.
 *
 * HOW THE SESSION WORKS
 * ---------------------
 * Every request is issued *from inside the signed-in page* via fetch(), so the
 * session cookie, the CSRF token, the origin and the referer are all whatever
 * their front end would have sent. No credentials are stored here; the user
 * stays signed in to their own browser, attached over CDP.
 *
 * WHAT THIS COSTS
 * ---------------
 * It is an undocumented endpoint. QuickMail can change it without warning, and
 * when they do this breaks. Two rules follow:
 *
 *   1. Every operation returns a typed failure rather than throwing into a page
 *      render. A broken sync must look broken, not look empty.
 *   2. Sending is gated exactly like the v2 client's mutations. Replying puts a
 *      real email in front of a real prospect; it never happens implicitly.
 */

const ORIGIN = "https://next.quickmail.com";

export function workspaceId(): string {
  return process.env.QUICKMAIL_WORKSPACE_ID ?? "54552";
}

/**
 * Deep link to a reply thread in QuickMail's own UI.
 *
 * Derived rather than stored: the pattern was confirmed by clicking a row, and
 * the workspace is a single configured value, so there is nothing to keep in
 * sync. If this app ever mirrors more than one workspace, the id has to come
 * from the conversation instead.
 */
export function opportunityUrl(opportunityId: string): string {
  return `${ORIGIN}/workspace/${workspaceId()}/opportunities/${opportunityId}`;
}

export class QuickMailSessionError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "QuickMailSessionError";
  }
}

/** ---------------------------------------------------------------- session */

const TRANSPORT_RETRIES = 4;

/**
 * Whether a failure is worth retrying.
 *
 * These all mean "the request never got an answer" — a dropped connection, or
 * the page navigating out from under the evaluate. Anything else is a real
 * response and must not be repeated, since some of these calls send email.
 */
function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch|NetworkError|ERR_|Execution context was destroyed|Target closed|navigation|detached/i.test(
    message,
  );
}

export type Session = {
  gql: <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
  page: Page;
};

/**
 * Attaches to the user's signed-in browser and hands a GraphQL caller to `fn`.
 *
 * The page is left where it was found. Detaching does not close their browser —
 * for a CDP-attached browser, close() only drops the connection.
 */
export async function withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  /**
   * The browser lives on the server, so the server starts it.
   *
   * This used to tell whoever hit the error to relaunch Edge — nonsense when
   * the dashboard is open on a different machine, which is the normal case on
   * a shared network. Nobody but the server can usefully act on it.
   */
  const state = await ensureDebuggableBrowser();
  if (!state.ok) {
    throw new QuickMailSessionError(
      `Could not start the automation browser on ${serverLabel()}: ${state.reason}.`,
    );
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const ctx = browser.contexts()[0];
    if (!ctx) throw new QuickMailSessionError("Attached browser has no context");

    let page = ctx.pages().find((p) => p.url().startsWith(ORIGIN));
    if (!page) {
      page = await ctx.newPage();
      await page.goto(`${ORIGIN}/workspace/${workspaceId()}/opportunities`, {
        waitUntil: "domcontentloaded",
      });

      /**
       * Wait for the session to resolve rather than sampling once.
       *
       * QuickMail sits on /login for a moment while it works out who you are,
       * then swaps to the workspace. A single check after a fixed four seconds
       * caught that intermediate state and called a signed-in browser signed
       * out — which failed the reply pull, and skipped classification and
       * manager forwarding with it, for a whole pass. A genuinely signed-out
       * browser stays on /login and still fails, just fifteen seconds later.
       */
      for (let i = 0; i < 15 && page.url().includes("/login"); i++) {
        await page.waitForTimeout(1000);
      }
    }

    // A signed-out session renders the marketing site or bounces to /login.
    if (page.url().includes("/login") || !page.url().startsWith(ORIGIN)) {
      /**
       * The one step that still needs a person, and it is on the server.
       *
       * No QuickMail password is stored anywhere by design, so the session has
       * to be established by hand once; the profile keeps it afterwards. Say
       * where to do it, because whoever reads this is probably sitting
       * somewhere else.
       */
      throw new QuickMailSessionError(
        `The automation browser on ${serverLabel()} is not signed in to QuickMail. ` +
          `Sign in there once — the session is then remembered and this is the ` +
          `last time anyone has to touch it.`,
      );
    }

    const gql = async <R>(query: string, variables: Record<string, unknown>) => {
      let result: { status: number; text: string } | null = null;
      let lastError: unknown = null;

      /**
       * Retry the transport, not the answer.
       *
       * A full sync is ~750 sequential round trips over roughly ten minutes,
       * and one "Failed to fetch" used to abort the whole run — a real sync
       * died at 240 of 374. Only connection-level failures are retried; a
       * GraphQL error or an HTTP status is an answer and is surfaced at once.
       */
      for (let attempt = 1; attempt <= TRANSPORT_RETRIES; attempt++) {
        try {
          result = await page!.evaluate(
            async ([q, v]) => {
              const csrf =
                document
                  .querySelector('meta[name="csrf-token"]')
                  ?.getAttribute("content") ?? "";
              const res = await fetch("/graphql", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json, text/plain, */*",
                  "X-CSRF-Token": csrf,
                },
                body: JSON.stringify({ query: q, variables: v }),
              });
              return { status: res.status, text: await res.text() };
            },
            [query, variables] as [string, Record<string, unknown>],
          );
          break;
        } catch (error) {
          lastError = error;
          if (!isTransient(error) || attempt === TRANSPORT_RETRIES) break;

          const wait = 1_000 * 2 ** (attempt - 1); // 1s, 2s, 4s
          console.warn(
            `[quickmail] request failed (attempt ${attempt}/${TRANSPORT_RETRIES}), retrying in ${wait / 1000}s`,
          );
          await new Promise((r) => setTimeout(r, wait));
          // A reload also recovers a page that navigated mid-run.
          await page!.waitForLoadState("domcontentloaded").catch(() => {});
        }
      }

      if (!result) {
        throw new QuickMailSessionError(
          `QuickMail request failed after ${TRANSPORT_RETRIES} attempts: ` +
            `${lastError instanceof Error ? lastError.message : "unknown"}`,
          lastError,
        );
      }

      let json: { data?: R; errors?: { message: string }[] };
      try {
        json = JSON.parse(result.text);
      } catch {
        throw new QuickMailSessionError(
          `QuickMail returned ${result.status} and not JSON`,
          result.text.slice(0, 300),
        );
      }
      if (json.errors?.length) {
        throw new QuickMailSessionError(
          json.errors.map((e) => e.message).join("; "),
          json.errors,
        );
      }
      if (!json.data) throw new QuickMailSessionError("QuickMail returned no data");
      return json.data;
    };

    return await fn({ gql, page });
  } finally {
    // Only drops the CDP connection — the user's browser stays open.
    await browser?.close().catch(() => {});
  }
}

/** ------------------------------------------------------------------ types */

export type OpportunitySummary = {
  id: string;
  state: string | null;
  subject: string | null;
  preview: string | null;
  waitingSince: string | null;
  aiSummary: string | null;
  replyType: string | null;
  isOoo: boolean;
  /**
   * "email" or "linkedin", from QuickMail.
   *
   * The only reliable way to tell the two apart. LinkedIn outreach is filed as
   * an opportunity exactly like an email thread, but has no address, no
   * sending mailbox and nothing to reply to — inferring it from an address
   * ending in @linkedin.profile happened to work and is not their contract.
   */
  channel: string | null;
  inbox: { id: string; email: string; name: string | null } | null;
  prospect: {
    id: string;
    name: string | null;
    email: string | null;
    title: string | null;
    role: string | null;
    phone: string | null;
    doNotContact: boolean;
    company: string | null;
  } | null;
  campaign: { id: string; name: string } | null;
};

export type ThreadMessage = {
  todoId: string;
  messageId: string | null;
  type: string | null;
  /** QuickMail's own classification of the reply, when it made one. */
  replyType: string | null;
  isOoo: boolean;
  author: string | null;
  createdAt: string | null;
  subject: string | null;
  /** HTML body as delivered. */
  body: string | null;
  /** Plain-text rendering, when QuickMail has one. */
  content: string | null;
  fromName: string | null;
  fromEmail: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  date: string | null;
  inbox: { id: string; email: string } | null;
};

export type OpportunityThread = {
  id: string;
  state: string | null;
  /** QuickMail returns this as a number; kept as text so it stores as-is. */
  status: string | null;
  aiSummary: string | null;
  createdAt: string | null;
  /** The todo a reply must be attached to. Null means it cannot be replied to. */
  replyableTodoId: string | null;
  inbox: { id: string; email: string; name: string | null } | null;
  prospect: OpportunitySummary["prospect"];
  campaign: { id: string; name: string } | null;
  messages: ThreadMessage[];
};

/** ---------------------------------------------------------------- queries */

/**
 * The operations below are QuickMail's own, copied from their bundle and
 * trimmed to the fields actually used. `searchFilter` is a JSON *string* — that
 * is how their front end sends it, not a mistake.
 */
const LIST_QUERY = `
  query appComponentsWorkspaceOpportunities($accountId: ID!, $first: Int, $skip: Int, $searchFilter: String) {
    account(accountId: $accountId) {
      id
      opportunities(first: $first, skip: $skip, searchFilter: $searchFilter) {
        totalCount
        pageInfo { endCursor hasNextPage }
        edges {
          node {
            id
            state
            subject
            preview
            waitingSince
            aiSummary
            latestReply { id replyType aiReplyType channelType isOoo }
            inbox { id name email }
            prospect {
              id name email title role phone doNotContact
              company { id name }
            }
            campaign { id name }
          }
        }
      }
    }
  }
`;

const THREAD_QUERY = `
  query workspaceAppOpportunity($scopeId: ID!, $opportunityId: ID!, $skip: Int, $limit: Int) {
    account(accountId: $scopeId) {
      id
      opportunity(opportunityId: $opportunityId) {
        id
        state
        status
        aiSummary
        createdAt
        latestReplyableTodo { id }
        inbox { id name email }
        prospect {
          id name email title role phone doNotContact
          company { id name }
        }
        campaign { id name }
        todos(skip: $skip, limit: $limit) {
          id
          type
          author
          createdAt
          replyType
          isOoo
          inbox { id email }
          message {
            id subject body content fromName fromEmail from to cc date
          }
        }
      }
    }
  }
`;

/**
 * ReplyToEmailInput's field list came from the call site in their bundle:
 *   {todoId, inboxId, html, subject, preview, attachments, to, cc, bcc, archive}
 * Introspection is disabled on this endpoint, so reading the caller was the
 * only way to learn the shape.
 */
const REPLY_MUTATION = `
  mutation replyToEmail($input: ReplyToEmailInput!) {
    replyToEmail(input: $input) {
      error
      sentTodo {
        id
        opportunity { id state }
      }
    }
  }
`;

/** Which slice of the inbox to read. Mirrors the filter chips in their UI. */
export type InboxScope = "me" | "others" | "unassigned" | "all";

function searchFilter(scope: InboxScope, text = ""): string {
  return JSON.stringify({
    state: "active_and_pending",
    assigned: scope,
    logon_id: "all",
    group_by: "active_desc",
    text,
  });
}

type ListResponse = {
  account: {
    opportunities: {
      totalCount: number;
      edges: {
        node: {
          id: string;
          state: string | null;
          subject: string | null;
          preview: string | null;
          waitingSince: string | null;
          aiSummary: string | null;
          latestReply: {
            replyType: string | null;
            isOoo: boolean;
            channelType: string | null;
          } | null;
          inbox: { id: string; name: string | null; email: string } | null;
          prospect: {
            id: string;
            name: string | null;
            email: string | null;
            title: string | null;
            role: string | null;
            phone: string | null;
            doNotContact: boolean;
            company: { name: string } | null;
          } | null;
          campaign: { id: string; name: string } | null;
        };
      }[];
    };
  };
};

export async function listOpportunities(
  s: Session,
  opts: { scope?: InboxScope; limit?: number; skip?: number } = {},
): Promise<{ total: number; items: OpportunitySummary[] }> {
  const data = await s.gql<ListResponse>(LIST_QUERY, {
    accountId: workspaceId(),
    first: opts.limit ?? 50,
    skip: opts.skip ?? 0,
    searchFilter: searchFilter(opts.scope ?? "all"),
  });

  const conn = data.account.opportunities;
  return {
    total: conn.totalCount,
    items: conn.edges.map(({ node }) => ({
      id: node.id,
      state: node.state,
      subject: node.subject,
      preview: node.preview,
      waitingSince: node.waitingSince,
      aiSummary: node.aiSummary,
      replyType: node.latestReply?.replyType ?? null,
      isOoo: node.latestReply?.isOoo ?? false,
      channel: node.latestReply?.channelType ?? null,
      inbox: node.inbox
        ? { id: node.inbox.id, email: node.inbox.email, name: node.inbox.name }
        : null,
      prospect: node.prospect
        ? {
            id: node.prospect.id,
            name: node.prospect.name,
            email: node.prospect.email,
            title: node.prospect.title,
            role: node.prospect.role,
            phone: node.prospect.phone,
            doNotContact: node.prospect.doNotContact,
            company: node.prospect.company?.name ?? null,
          }
        : null,
      campaign: node.campaign,
    })),
  };
}

type ThreadResponse = {
  account: {
    opportunity: {
      id: string;
      state: string | null;
      status: string | number | null;
      aiSummary: string | null;
      createdAt: string | null;
      latestReplyableTodo: { id: string } | null;
      inbox: { id: string; name: string | null; email: string } | null;
      prospect: ListResponse["account"]["opportunities"]["edges"][number]["node"]["prospect"];
      campaign: { id: string; name: string } | null;
      todos: {
        id: string;
        type: string | null;
        author: string | null;
        createdAt: string | null;
        replyType: string | null;
        isOoo: boolean;
        inbox: { id: string; email: string } | null;
        message: {
          id: string;
          subject: string | null;
          body: string | null;
          content: string | null;
          fromName: string | null;
          fromEmail: string | null;
          from: string | null;
          to: string | null;
          cc: string | null;
          date: string | null;
        } | null;
      }[];
    } | null;
  };
};

export async function getThread(
  s: Session,
  opportunityId: string,
  limit = 30,
): Promise<OpportunityThread | null> {
  const data = await s.gql<ThreadResponse>(THREAD_QUERY, {
    scopeId: workspaceId(),
    opportunityId,
    skip: 0,
    limit,
  });

  const o = data.account.opportunity;
  if (!o) return null;

  return {
    id: o.id,
    state: o.state,
    status: o.status === null || o.status === undefined ? null : String(o.status),
    aiSummary: o.aiSummary,
    createdAt: o.createdAt,
    replyableTodoId: o.latestReplyableTodo?.id ?? null,
    inbox: o.inbox
      ? { id: o.inbox.id, email: o.inbox.email, name: o.inbox.name }
      : null,
    prospect: o.prospect
      ? {
          id: o.prospect.id,
          name: o.prospect.name,
          email: o.prospect.email,
          title: o.prospect.title,
          role: o.prospect.role,
          phone: o.prospect.phone,
          doNotContact: o.prospect.doNotContact,
          company: o.prospect.company?.name ?? null,
        }
      : null,
    campaign: o.campaign,
    messages: o.todos
      // A todo without a message is a task (a call, a LinkedIn step), not mail.
      .filter((t) => t.message)
      .map((t) => ({
        todoId: t.id,
        messageId: t.message!.id,
        type: t.type,
        replyType: t.replyType,
        isOoo: t.isOoo,
        author: t.author,
        createdAt: t.createdAt,
        subject: t.message!.subject,
        body: t.message!.body,
        content: t.message!.content,
        fromName: t.message!.fromName,
        fromEmail: t.message!.fromEmail,
        from: t.message!.from,
        to: t.message!.to,
        cc: t.message!.cc,
        date: t.message!.date,
        inbox: t.inbox,
      })),
  };
}

/** --------------------------------------------------------------- stopping */

/**
 * Input shapes came from the call sites in QuickMail's bundle, since
 * introspection is disabled:
 *   setProspectsAsDoNotContact  {prospectIds, doNotContact}
 *   cancelProspects             {accountId, prospectIds}
 */
const DNC_MUTATION = `
  mutation setProspectsAsDoNotContact($input: SetProspectsAsDoNotContactInput!) {
    setProspectsAsDoNotContact(input: $input) { error }
  }
`;

const CANCEL_MUTATION = `
  mutation cancelProspects($input: CancelProspectsInput!) {
    cancelProspects(input: $input) { error }
  }
`;

export type StopResult = {
  dryRun: boolean;
  /** Marked do-not-contact, so no future campaign enrols them. */
  doNotContact: boolean;
  /** In-flight sequence cancelled, so nothing already queued goes out. */
  cancelled: boolean;
  errors: string[];
};

/**
 * Stops QuickMail from emailing a prospect.
 *
 * Two operations, because they do different things and only doing one leaves a
 * hole. Do-not-contact prevents future enrolment; it does not necessarily halt
 * a journey already running, and a queued follow-up going out after someone
 * asked to stop is the failure that matters. Cancelling the journey handles the
 * in-flight case.
 *
 * Best-effort by design: the caller has already barred the address locally, and
 * that must not be rolled back because QuickMail was unreachable. Failures come
 * back in `errors` so the UI can say what still needs doing by hand.
 */
export async function stopProspect(
  s: Session,
  prospectId: string,
): Promise<StopResult> {
  const result: StopResult = {
    dryRun: false,
    doNotContact: false,
    cancelled: false,
    errors: [],
  };

  if (process.env.QUICKMAIL_DRY_RUN !== "false") {
    console.log("[quickmail:dry-run] stopProspect", prospectId);
    return { ...result, dryRun: true };
  }

  try {
    const data = await s.gql<{
      setProspectsAsDoNotContact: { error: string | null };
    }>(DNC_MUTATION, { input: { prospectIds: [prospectId], doNotContact: true } });

    const error = data.setProspectsAsDoNotContact?.error;
    if (error) result.errors.push(`do-not-contact: ${error}`);
    else result.doNotContact = true;
  } catch (e) {
    result.errors.push(`do-not-contact: ${(e as Error).message}`);
  }

  try {
    const data = await s.gql<{ cancelProspects: { error: string | null } }>(
      CANCEL_MUTATION,
      { input: { accountId: workspaceId(), prospectIds: [prospectId] } },
    );

    const error = data.cancelProspects?.error;
    if (error) result.errors.push(`cancel sequence: ${error}`);
    else result.cancelled = true;
  } catch (e) {
    result.errors.push(`cancel sequence: ${(e as Error).message}`);
  }

  return result;
}

/** ------------------------------------------------------------------ send */

export type SendReplyInput = {
  /** The message being answered — QuickMail threads the reply onto this. */
  todoId: string;
  /** Which of the sending mailboxes it goes out from. */
  inboxId: string;
  subject: string;
  /** Body as HTML. QuickMail's composer is an HTML editor. */
  html: string;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  /** Inbox preheader. */
  preview?: string | null;
  /** Close the opportunity once the reply goes out. */
  archive?: boolean;
};

/**
 * Sends a real email to a real prospect.
 *
 * Gated behind QUICKMAIL_DRY_RUN like every other write in this project. The
 * default is dry-run, and the caller has to opt out deliberately — this is the
 * one operation here with no undo.
 */
export async function sendReply(
  s: Session,
  input: SendReplyInput,
): Promise<{ sent: boolean; dryRun: boolean; todoId?: string; error?: string }> {
  if (process.env.QUICKMAIL_DRY_RUN !== "false") {
    console.log("[quickmail:dry-run] replyToEmail", {
      to: input.to,
      subject: input.subject,
      inboxId: input.inboxId,
    });
    return { sent: false, dryRun: true };
  }

  const data = await s.gql<{
    replyToEmail: { error: string | null; sentTodo: { id: string } | null };
  }>(REPLY_MUTATION, {
    input: {
      todoId: input.todoId,
      inboxId: input.inboxId,
      html: input.html,
      subject: input.subject,
      preview: input.preview ?? "",
      attachments: [],
      to: input.to,
      cc: input.cc ?? "",
      bcc: input.bcc ?? "",
      archive: input.archive ?? false,
    },
  });

  const result = data.replyToEmail;
  if (result.error) return { sent: false, dryRun: false, error: result.error };

  return { sent: true, dryRun: false, todoId: result.sentTodo?.id };
}
