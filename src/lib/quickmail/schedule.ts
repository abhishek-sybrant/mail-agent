import { prisma } from "@/lib/prisma";
import { isDryRun, query } from "./client";

/**
 * Campaign start/end dates, enforced by this app.
 *
 * QuickMail has no campaign-level date or pause mutation — the whole schema
 * was searched. But `updateEmailStep` accepts `paused` per variation, so the
 * same effect is achievable: pause every email variation and the campaign
 * sends nothing; unpause them and it resumes.
 *
 * So a campaign window works like this:
 *   before start → every email variation paused   (PENDING)
 *   at start     → unpaused                       (RUNNING)
 *   at end       → paused again                   (ENDED)
 *
 * `paused` is writable but not readable on EmailVariation, so the intended
 * state is tracked locally in Campaign.schedule_state.
 */

const STEPS_QUERY = `
  query CampaignSteps($id: ID!) {
    campaign(id: $id) {
      id
      name
      steps {
        nodes {
          position
          variations { nodes { id type } }
        }
      }
    }
  }
`;

const UPDATE_EMAIL_STEP = `
  mutation SetPaused($input: UpdateEmailStepInput!) {
    updateEmailStep(input: $input) { clientMutationId }
  }
`;

/** Every email variation in a campaign — the things that can be paused. */
export async function emailVariationIds(
  quickmailCampaignId: string,
): Promise<string[]> {
  const data = await query<{
    campaign: {
      steps: {
        nodes: { position: number; variations: { nodes: { id: string; type: string }[] } }[];
      };
    } | null;
  }>(STEPS_QUERY, { id: quickmailCampaignId });

  if (!data.campaign) return [];

  return data.campaign.steps.nodes.flatMap((s) =>
    s.variations.nodes
      .filter((v) => v.type === "EmailVariation")
      .map((v) => v.id),
  );
}

/** Pause or resume every email step in a campaign. */
export async function setCampaignSending(
  quickmailCampaignId: string,
  sending: boolean,
): Promise<{ changed: number; dryRun: boolean }> {
  const ids = await emailVariationIds(quickmailCampaignId);

  if (isDryRun()) {
    console.log(
      `[schedule:dry-run] would set paused=${!sending} on ${ids.length} variations`,
    );
    return { changed: ids.length, dryRun: true };
  }

  for (const variationId of ids) {
    await query(UPDATE_EMAIL_STEP, {
      input: { variationId, paused: !sending },
    });
  }

  return { changed: ids.length, dryRun: false };
}

export type TickResult = {
  started: string[];
  ended: string[];
  errors: { campaign: string; message: string }[];
  checked: number;
};

/**
 * Applies any schedule that has come due. Safe to call repeatedly — state is
 * only advanced forward, so a duplicate run is a no-op.
 */
export async function applyDueSchedules(now = new Date()): Promise<TickResult> {
  const out: TickResult = { started: [], ended: [], errors: [], checked: 0 };

  const scheduled = await prisma.campaign.findMany({
    where: {
      quickmail_campaign_id: { not: null },
      schedule_state: { in: ["PENDING", "RUNNING"] },
    },
  });
  out.checked = scheduled.length;

  for (const c of scheduled) {
    const qmId = c.quickmail_campaign_id!;
    try {
      const endDue = c.scheduled_end !== null && c.scheduled_end <= now;
      const startDue =
        c.schedule_state === "PENDING" &&
        c.scheduled_start !== null &&
        c.scheduled_start <= now;

      // Ending takes priority: if both moments have passed since the last
      // tick, the campaign should end up stopped, not started.
      if (endDue) {
        await setCampaignSending(qmId, false);
        await prisma.campaign.update({
          where: { id: c.id },
          data: {
            // Keep `status` in step with the schedule, or the dashboard shows a
            // stopped campaign as active.
            status: "PAUSED",
            schedule_state: "ENDED",
            schedule_note: `Stopped ${now.toISOString()}`,
          },
        });
        out.ended.push(c.name);
        continue;
      }

      if (startDue) {
        await setCampaignSending(qmId, true);
        await prisma.campaign.update({
          where: { id: c.id },
          data: {
            status: "ACTIVE",
            schedule_state: "RUNNING",
            schedule_note: `Started ${now.toISOString()}`,
          },
        });
        out.started.push(c.name);
      }
    } catch (error) {
      out.errors.push({ campaign: c.name, message: (error as Error).message });
    }
  }

  return out;
}
