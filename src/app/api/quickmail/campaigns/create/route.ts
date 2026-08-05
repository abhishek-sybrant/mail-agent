import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isDryRun, query, QuickMailError } from "@/lib/quickmail/client";
import {
  ADD_LEADS_TO_CAMPAIGN,
  CREATE_CAMPAIGN,
  CREATE_EMAIL_STEP,
  CREATE_LEADS,
  CREATE_WAIT_STEP,
  findExistingLeads,
  SET_ACCOUNTS,
  UPDATE_AUTOMATION,
  type QmLeadInput,
} from "@/lib/quickmail/mutations";
import { badRequest, optionalString, readJson } from "@/lib/webhook";
import { syncMailboxes } from "@/lib/quickmail/sync";
import { normalise, partitionSuppressed } from "@/lib/suppression";
import { TIMEZONES } from "@/lib/agent/campaign-spec";
import {
  prepareEmailBody,
  toQuickMailTags,
  type MergeTagResult,
} from "@/lib/quickmail/merge-tags";
import {
  finishCampaignInUi,
  uiAutomationEnabled,
  type UiResult,
} from "@/lib/quickmail/ui-automation";

/**
 * Surfaces placeholder problems on the way out.
 *
 * An unmapped tag is the dangerous one: QuickMail sends it verbatim, so the
 * prospect reads "Hi {{firstName}}". An unproven tag is milder — it resolves,
 * but may resolve to nothing in this workspace.
 */
function noteTagIssues(where: string, r: MergeTagResult, warnings: string[]) {
  if (r.unknown.length > 0) {
    warnings.push(
      `${where}: QuickMail does not know ${[...new Set(r.unknown)].join(", ")} — ` +
        `it will be sent to the prospect as literal text. Use {{lead.first_name}}.`,
    );
  }
  if (r.unproven.length > 0) {
    warnings.push(
      `${where}: ${r.unproven.join(", ")} is valid syntax but no campaign in ` +
        `this workspace uses it, so it may render empty.`,
    );
  }
}

/**
 * QuickMail wants an IANA zone and hard-errors on anything else
 * ("Invalid time zone: '(GMT-05:00) Eastern Time (US & Canada)'"). The picker
 * shows GMT-offset labels, so a label can reach us instead of the value —
 * translate it back rather than letting the automation call fail, which would
 * leave the campaign with no sending window at all.
 */
function toIanaZone(input: string | null): string | null {
  if (!input) return null;
  const byValue = TIMEZONES.find((t) => t.value === input);
  if (byValue) return byValue.value;
  const byLabel = TIMEZONES.find((t) => t.label === input);
  if (byLabel) return byLabel.value;
  // Anything else is passed through only if it looks like a zone id.
  return /^[A-Za-z]+\/[A-Za-z_+-]+$/.test(input) ? input : null;
}

export const maxDuration = 120;

type StepInput = {
  subject?: string;
  body?: string;
  wait_days?: number;
};

/**
 * POST /api/quickmail/campaigns/create
 *
 * Builds a complete sequence in QuickMail and enrols the selected leads:
 *
 *   createCampaign → setCampaignEmailAccounts → createEmailStep
 *     → (createWaitStep → createEmailStep)* for each follow-up
 *     → createWaitStep (trailing; a sequence ending on an email never sends)
 *     → createLeads → addLeadsToCampaign
 *
 * `launch_mode` decides how finished the steps are — see the comment on it
 * below. Anything short of "live" leaves the steps paused, so QuickMail sends
 * nothing until a human unpauses the campaign there. A scheduled campaign is
 * always held paused regardless, because the scheduler needs something to
 * release at the start moment.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const name = optionalString(body.name);
  const subject = optionalString(body.subject);
  const emailBody = optionalString(body.body);
  if (!name) return badRequest("`name` is required");
  if (!subject) return badRequest("`subject` is required");
  if (!emailBody) return badRequest("`body` is required");

  const mailboxIds = Array.isArray(body.email_account_ids)
    ? body.email_account_ids.filter((v): v is string => typeof v === "string")
    : [];
  if (mailboxIds.length === 0) {
    return badRequest("Select at least one sending mailbox");
  }

  const leadIds = Array.isArray(body.lead_ids)
    ? body.lead_ids.filter((v): v is string => typeof v === "string")
    : [];

  const followUps: StepInput[] = Array.isArray(body.follow_ups)
    ? (body.follow_ups as StepInput[])
    : [];

  // Campaign window. QuickMail has no field for this, so the scheduler holds
  // the email steps paused until the start moment and re-pauses at the end.
  const sched = (body.schedule ?? {}) as Record<string, unknown>;
  const toDate = (d: unknown, t: unknown): Date | null => {
    if (typeof d !== "string" || !d) return null;
    const time = typeof t === "string" && t ? t : "00:00";
    const parsed = new Date(`${d}T${time}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  /**
   * How finished the steps should be when they land in QuickMail.
   *
   *   paused → draft + paused. Review each step there before anything runs.
   *   ready  → finalised but paused. One click in QuickMail starts it.
   *   live   → finalised and running. Sends on the next scheduled slot.
   *
   * A campaign with a start date is always held paused whatever is asked for,
   * otherwise the scheduler has nothing to release and the date is a lie.
   */
  const requested = optionalString(body.launch_mode) ?? "ready";
  const launchMode: "paused" | "ready" | "live" =
    requested === "live" || requested === "paused" ? requested : "ready";

  const scheduledStart = toDate(sched.start_date, sched.start_at);
  const scheduledEnd = toDate(sched.end_date, sched.end_at);

  const heldForSchedule = scheduledStart !== null;
  const stepDraft = launchMode === "paused";
  const stepPaused = launchMode !== "live" || heldForSchedule;

  // Daily sending schedule — this part QuickMail *can* store.
  const ALL_DAYS = [
    "sunday", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday",
  ] as const;
  const chosenDays = Array.isArray(sched.days)
    ? (sched.days as unknown[]).filter(
        (d): d is string => typeof d === "string" && (ALL_DAYS as readonly string[]).includes(d),
      )
    : [];
  const fromTime = typeof sched.from === "string" ? sched.from : null;
  const toTime = typeof sched.to === "string" ? sched.to : null;
  /** The agent conversation that produced this, when it came from the agent. */
  const requestedConversationId = optionalString(body.conversation_id);

  /**
   * Preheader and cc/bcc. All three are writable on the email step but NOT
   * readable back, so this is the only record of what was set.
   *
   * Without a preview, most clients show the first body line after the subject,
   * which reads as "Hi Dhilak," — a wasted slot in the inbox.
   */
  const preview = optionalString(body.preview);
  const cc = optionalString(body.cc);
  const bcc = optionalString(body.bcc);

  /** Anything that is clearly not an address is worth flagging, not silently sent. */
  const badAddresses = [cc, bcc]
    .filter((v): v is string => Boolean(v))
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));

  const rawZone = typeof sched.timezone === "string" ? sched.timezone : null;
  const timeZone = toIanaZone(rawZone);
  const badZone = rawZone !== null && timeZone === null ? rawZone : null;
  const allHours = sched.all_hours === true;

  // Never enrol a suppressed, bounced or opted-out lead, whatever was selected.
  const candidates = await prisma.lead.findMany({
    where: {
      id: { in: leadIds },
      suppressed: false,
      status: { in: ["UNCONTACTED", "EMAILED"] },
    },
  });

  /**
   * Second gate: the suppression list, keyed on the address.
   *
   * The Lead flags above are not enough on their own. A re-imported
   * spreadsheet creates a fresh Lead with `suppressed` false and status
   * UNCONTACTED, so a known-dead address sails through — which is how the same
   * addresses came to bounce roughly 41 times each. This check survives that
   * because it never looks at the Lead row.
   */
  const { blocked } = await partitionSuppressed(candidates.map((l) => l.email));
  const barred = new Set(blocked.map((b) => b.email));
  const leads = candidates.filter((l) => !barred.has(normalise(l.email)));
  const skipped = leadIds.length - leads.length;

  const qmLeads: QmLeadInput[] = leads.map((l) => ({
    email: l.email,
    firstName: l.first_name ?? l.name?.split(" ")[0] ?? null,
    lastName: l.last_name ?? l.name?.split(" ").slice(1).join(" ") ?? null,
    companyName: l.company,
    title: l.title,
    phone: l.phone,
    location: l.location,
    score: l.ai_intent_score,
  }));

  const plan = [
    { mutation: "createCampaign", detail: name },
    { mutation: "setCampaignEmailAccounts", detail: `${mailboxIds.length} mailbox(es)` },
    ...(chosenDays.length > 0 || timeZone
      ? [
          {
            mutation: "updateCampaignAutomation",
            detail: `${chosenDays.length || 7} days · ${
              allHours ? "all hours" : `${fromTime ?? "09:00"}-${toTime ?? "17:00"}`
            }${timeZone ? ` · ${timeZone}` : ""}`,
          },
        ]
      : []),
    {
      mutation: "createEmailStep",
      detail: `"${subject}" (${stepDraft ? "draft, " : ""}${stepPaused ? "paused" : "LIVE"})`,
    },
    ...followUps.flatMap((f, i) => [
      { mutation: "createWaitStep", detail: `${f.wait_days ?? 3} days` },
      {
        mutation: "createEmailStep",
        detail: `follow-up ${i + 1}: "${f.subject ?? "(re: same thread)"}" (${stepDraft ? "draft, " : ""}${stepPaused ? "paused" : "LIVE"})`,
      },
    ]),
    { mutation: "createWaitStep", detail: "trailing wait (required to send)" },
    { mutation: "createLeads", detail: `${qmLeads.length} leads` },
    { mutation: "addLeadsToCampaign", detail: `${qmLeads.length} leads` },
  ];

  // The UI toggle can request a live run, but only when the environment
  // already permits writes — QUICKMAIL_DRY_RUN=true is an absolute lock, so a
  // crafted request can't bypass the server-side guard.
  const header = request.headers.get("x-dry-run");
  const wantsLive = header === "false";
  const effectiveDryRun = isDryRun() || !wantsLive;

  if (effectiveDryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      plan,
      leads_selected: leadIds.length,
      leads_eligible: qmLeads.length,
      leads_skipped: skipped,
      message: isDryRun()
        ? "Dry run — nothing written. QUICKMAIL_DRY_RUN=true in .env locks all writes; set it to false to enable the live toggle."
        : "Dry run — nothing written. Tick 'Write to QuickMail for real' to apply.",
      env_locked: isDryRun(),
    });
  }

  try {
    let workspaceId = optionalString(body.workspace_id);
    if (!workspaceId) {
      const ws = await query<{ workspaces: { nodes: { id: string }[] } }>(
        `{ workspaces(first: 1) { nodes { id } } }`,
      );
      workspaceId = ws.workspaces.nodes[0]?.id ?? null;
    }
    if (!workspaceId) return badRequest("No workspace available");

    // 1 — the campaign shell
    const created = await query<{
      createCampaign: {
        campaign: { id: string; name: string; appUrl: string };
      };
    }>(CREATE_CAMPAIGN, { input: { workspaceId, name } });
    const campaign = created.createCampaign.campaign;

    // 2 — sending mailboxes.
    //
    // QuickMail 500s on some mailboxes and succeeds on others, with no
    // discoverable pattern. Aborting here used to leave an orphaned, stepless
    // campaign behind, so instead each mailbox is assigned individually and a
    // failure becomes a warning: the campaign still gets built.
    const warnings: string[] = [];
    if (badZone) {
      warnings.push(
        `"${badZone}" is not a timezone QuickMail recognises — the sending ` +
          `window was set without one, using the workspace default.`,
      );
    }
    const assigned: string[] = [];

    /**
     * A deauthorized mailbox attaches without complaint and then sends nothing
     * at all — leads sit at "active" indefinitely with no error on the campaign,
     * the mailbox or the step. Refuse it here; that failure is invisible later.
     *
     * Checked live rather than from the local cache. Authorization is revoked
     * without warning — a mailbox that synced as authorized this morning was
     * dead by the afternoon, so the cached copy let an unusable sender through
     * and the campaign silently could not go Live. One extra request is worth
     * more than a campaign that looks fine and never sends.
     */
    // Resolve the chat link now, so a stale id degrades to null rather than
    // exploding on a foreign key after the QuickMail campaign already exists.
    const conversationId = requestedConversationId
      ? ((
          await prisma.agentConversation.findUnique({
            where: { id: requestedConversationId },
            select: { id: true },
          })
        )?.id ?? null)
      : null;

    await syncMailboxes().catch(() => undefined);
    const dead = await prisma.qmMailbox.findMany({
      where: { id: { in: mailboxIds }, OR: [{ authorized: false }, { qm_paused: true }] },
    });
    if (dead.length === mailboxIds.length) {
      return badRequest(
        `Every selected mailbox is disconnected in QuickMail ` +
          `(${dead.map((d) => d.email).join(", ")}). Reconnect one under ` +
          `Settings → Email Accounts, then create the campaign.`,
      );
    }
    const deadIds = new Set(dead.map((d) => d.id));
    for (const d of dead) {
      warnings.push(
        `Skipped ${d.email} — disconnected in QuickMail, it would never send.`,
      );
    }

    for (const mailboxId of mailboxIds.filter((id) => !deadIds.has(id))) {
      try {
        await query(SET_ACCOUNTS, {
          input: { campaignId: campaign.id, emailAccountIds: [mailboxId], assign: true },
        });
        assigned.push(mailboxId);
        await prisma.qmMailbox
          .update({ where: { id: mailboxId }, data: { assignable: true } })
          .catch(() => undefined);
      } catch (error) {
        const box = await prisma.qmMailbox.findUnique({ where: { id: mailboxId } });
        warnings.push(
          `Couldn't attach ${box?.email ?? mailboxId}: ${(error as Error).message}. Attach it by hand in QuickMail.`,
        );
        await prisma.qmMailbox
          .update({
            where: { id: mailboxId },
            data: { assignable: false, assign_error_at: new Date() },
          })
          .catch(() => undefined);
      }
    }

    // 3 — sending window. Collected by the agent and, until now, silently
    // dropped: nothing ever called updateCampaignAutomation.
    if (chosenDays.length > 0 || timeZone) {
      const days = chosenDays.length > 0 ? chosenDays : [...ALL_DAYS];
      const start = allHours ? "00:00" : (fromTime ?? "09:00");
      const end = allHours ? "23:59" : (toTime ?? "17:00");

      try {
        await query(UPDATE_AUTOMATION, {
          input: {
            campaignId: campaign.id,
            ...(timeZone ? { timeZone } : {}),
            businessDays: Object.fromEntries(
              ALL_DAYS.map((d) => [d, days.includes(d)]),
            ),
            timeRanges: days.map((day) => ({
              day,
              startTime: start,
              endTime: end,
            })),
          },
        });
      } catch (error) {
        // Worth shouting about: with no sending window QuickMail has no slot to
        // send in, so the campaign sits there looking live and never sends.
        warnings.push(
          `Sending window NOT set (${(error as Error).message}) — the campaign ` +
            `will not send until you set the schedule by hand in QuickMail.`,
        );
      }
    }

    /**
     * 4 — first email.
     *
     * Placeholders are translated here rather than trusted from the caller.
     * QuickMail does not reject an unknown merge tag, it just sends the literal
     * `{{firstName}}` to the prospect, so this is the last place to catch it.
     * The subject is merged too — tags work there as well.
     */
    const preparedSubject = toQuickMailTags(subject);
    const preparedBody = prepareEmailBody(emailBody);
    // The preheader takes merge tags too, but stays plain text — it is inbox
    // chrome, not part of the HTML body.
    const preparedPreview = preview ? toQuickMailTags(preview) : null;
    noteTagIssues("first email", preparedSubject, warnings);
    noteTagIssues("first email", preparedBody, warnings);
    if (preparedPreview) noteTagIssues("preview text", preparedPreview, warnings);

    if (badAddresses.length > 0) {
      warnings.push(
        `These cc/bcc entries do not look like email addresses and were sent ` +
          `as-is: ${badAddresses.join(", ")}`,
      );
    }

    await query(CREATE_EMAIL_STEP, {
      input: {
        campaignId: campaign.id,
        subject: preparedSubject.text,
        body: preparedBody.text,
        ...(preparedPreview ? { preview: preparedPreview.text } : {}),
        ...(cc ? { cced: cc } : {}),
        ...(bcc ? { bcced: bcc } : {}),
        draft: stepDraft,
        paused: stepPaused,
        openTracking: true,
        clickTracking: true,
      },
    });

    // 5 — follow-ups, each preceded by a wait
    for (const f of followUps) {
      if (!f.body) continue;
      await query(CREATE_WAIT_STEP, {
        input: {
          campaignId: campaign.id,
          // QuickMail rejects the singular: valid units are
          // "minutes" | "hours" | "days".
          unit: "days",
          value: Math.max(1, f.wait_days ?? 3),
          business: true,
          paused: stepPaused,
        },
      });
      const fSubject = f.subject ? toQuickMailTags(f.subject) : null;
      const fBody = prepareEmailBody(f.body);
      if (fSubject) noteTagIssues("follow-up", fSubject, warnings);
      noteTagIssues("follow-up", fBody, warnings);

      await query(CREATE_EMAIL_STEP, {
        input: {
          campaignId: campaign.id,
          // No subject means QuickMail replies on the existing thread.
          ...(fSubject ? { subject: fSubject.text } : { continueThread: true }),
          body: fBody.text,
          // Follow-ups inherit cc/bcc so a watching colleague sees the whole
          // thread, not just the opener.
          ...(cc ? { cced: cc } : {}),
          ...(bcc ? { bcced: bcc } : {}),
          draft: stepDraft,
          paused: stepPaused,
          openTracking: true,
          clickTracking: true,
        },
      });
    }

    /**
     * A sequence must END on a wait step, not an email.
     *
     * Learned by comparing against the campaigns that actually send: every one
     * of them has an even step count (2, 4, 6) shaped Email→Wait[→Email→Wait].
     * A campaign ending on an email accepts leads and moves them to "active",
     * then never sends — no error on the campaign, the step or the lead. The
     * trailing wait is what makes the sequence runnable.
     */
    await query(CREATE_WAIT_STEP, {
      input: {
        campaignId: campaign.id,
        unit: "days",
        value: 3,
        business: true,
        paused: stepPaused,
      },
    });

    // 6 — leads: reuse QuickMail's existing records where they exist
    let enrolled = 0;
    if (qmLeads.length > 0) {
      const existing = await findExistingLeads(qmLeads.map((l) => l.email));
      const toCreate = qmLeads.filter(
        (l) => !existing.has(l.email.toLowerCase()),
      );

      const createdIds: string[] = [];
      if (toCreate.length > 0) {
        const res = await query<{
          createLeads: { leads: { id: string; email: string }[] };
        }>(CREATE_LEADS, { input: { workspaceId, leads: toCreate } });
        createdIds.push(...res.createLeads.leads.map((l) => l.id));
      }

      const allIds = [...existing.values(), ...createdIds];

      if (allIds.length > 0) {
        const added = await query<{
          addLeadsToCampaign: { leads: { id: string }[] };
        }>(ADD_LEADS_TO_CAMPAIGN, {
          input: { campaignId: campaign.id, leadIds: allIds },
        });
        enrolled = added.addLeadsToCampaign.leads.length;
      }

      // Mirror the enrolment locally so the dashboard counts stay honest.
      await prisma.lead.updateMany({
        where: { id: { in: leads.map((l) => l.id) } },
        data: { status: "EMAILED" },
      });
    }

    await prisma.campaign.create({
      data: {
        name,
        status: stepPaused ? "PAUSED" : "ACTIVE",
        quickmail_campaign_id: campaign.id,
        mailbox_ids: JSON.stringify(mailboxIds),
        scheduled_start: scheduledStart,
        scheduled_end: scheduledEnd,
        // Steps are created paused, so a scheduled campaign is already in the
        // right physical state — it just waits for the tick to release it.
        schedule_state: scheduledStart ? "PENDING" : null,
        /**
         * Which agent chat specified this, if any.
         *
         * Checked to exist first. The client sends an id it generated itself,
         * and a stale one — history cleared, different machine — would fail the
         * whole create on a foreign key after the campaign already exists in
         * QuickMail. Losing the link is a far smaller loss than that.
         */
        agent_conversation_id: conversationId,
      },
    });

    /**
     * The one thing the API cannot do.
     *
     * QuickMail campaigns need a *trigger* to start leads into the sequence.
     * It is separate from the sending window: the window says when sending is
     * allowed, the trigger is what actually admits leads. Without one the
     * campaign shows "Set triggers to start leads on the campaign" and every
     * lead sits at "active" forever, sending nothing and reporting no error.
     *
     * There is no trigger anywhere in the v2 schema — no type, field, input
     * field or enum mentions one — so it cannot be set or even read from here.
     * It has to be done once per campaign in the QuickMail UI, hence the deep
     * link rather than a vague instruction.
     */
    const automationUrl = campaign.appUrl
      ? `${campaign.appUrl.replace(/\/+$/, "")}/automation`
      : null;

    const perDay =
      typeof body.leads_per_day === "number" && body.leads_per_day > 0
        ? body.leads_per_day
        : null;

    /**
     * Both of these are UI-only. Listing them as concrete steps beats a warning
     * that says "something is wrong" without saying what to click.
     *
     * The unpause is unconditional, and deliberately not tied to `launchMode`.
     * QuickMail creates every campaign paused at the *campaign* level and there
     * is no mutation to change it — `launchMode` only governs the *steps*. A
     * campaign created "live" therefore still arrives paused, and tying this
     * step to launchMode hid that.
     */
    const manualSteps = [
      `Automation tab → add a trigger to start ${perDay ?? "N"} new leads per day` +
        (perDay ? "" : " (no daily limit was specified)"),
      "Unpause the campaign — QuickMail always creates it paused and the API " +
        "cannot change that",
    ];

    /**
     * Optional: drive the UI for the two API-impossible steps.
     *
     * Deliberately best-effort. The campaign already exists and its leads are
     * enrolled by this point, so a broken selector must not turn a successful
     * creation into a 502 — it falls back to `manualSteps` instead.
     */
    let ui: UiResult | null = null;
    if (uiAutomationEnabled() && automationUrl) {
      ui = await finishCampaignInUi({
        campaignUrl: automationUrl.replace(/\/automation$/, ""),
        leadsPerDay: perDay ?? 1,
        // Match the trigger to the schedule the agent collected, rather than
        // letting QuickMail default to Monday-only at the current clock time.
        days: chosenDays.length > 0 ? chosenDays : undefined,
        // The explicit trigger time, falling back to the window start.
        time: optionalString(body.trigger_at) ?? fromTime ?? undefined,
      });
      if (!ui.ok) {
        // Name the cause when QuickMail gave one. "See the log" sends the user
        // hunting for something the tool already knows.
        const why = ui.blockedBy
          ? `QuickMail refused: ${ui.blockedBy}`
          : (ui.error ?? "see ui_automation.log");
        warnings.push(
          `Automated finish did not complete — ${why}. ` +
            (ui.triggerSet
              ? "The trigger was set; only the switch to Live is outstanding."
              : "Do both steps by hand, listed below."),
        );
      }
    }

    return NextResponse.json({
      ok: true,
      dryRun: false,
      campaign,
      mailboxes_attached: assigned.length,
      ui_automation: ui,
      action_required: {
        what: ui?.ok
          ? "Trigger set and campaign unpaused automatically — verify below"
          : "Finish this campaign in QuickMail — it will not send otherwise",
        why:
          "A trigger is what starts leads into the sequence, and QuickMail's v2 " +
          "API cannot set one (no mutation or input field in the schema expresses " +
          "it). Without it every lead sits at 'active', nothing sends, and no " +
          "error is reported anywhere.",
        steps: manualSteps,
        where: automationUrl ?? "QuickMail → the campaign → Automation",
      },
      warnings,
      // first email + (wait + email) per follow-up + the trailing wait
      steps_created: 1 + followUps.filter((f) => f.body).length * 2 + 1,
      leads_enrolled: enrolled,
      leads_skipped: skipped,
      scheduled: scheduledStart
        ? {
            start: scheduledStart.toISOString(),
            end: scheduledEnd?.toISOString() ?? null,
            note:
              "Steps are held paused until this moment, then released by the " +
              "scheduler. This permits sending; it does not start the campaign — " +
              "the first send is whichever is later, this start or the moment a " +
              "trigger is added in QuickMail.",
          }
        : null,
      launch_mode: launchMode,
      note:
        "Set the trigger in QuickMail (Automation tab) — until you do, no lead " +
        "starts and nothing sends. " +
        (heldForSchedule
          ? "Steps are held paused until the scheduled start, then released " +
          "automatically — but nothing sends until the trigger exists."
          : stepPaused
            ? `Steps were created ${stepDraft ? "as drafts, " : ""}paused; unpause them too.`
            : "Steps are live, so it will send once the trigger is set."),
    });
  } catch (error) {
    const message =
      error instanceof QuickMailError || error instanceof Error
        ? error.message
        : "Campaign creation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
