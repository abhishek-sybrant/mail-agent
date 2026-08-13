import { prisma } from "@/lib/prisma";

/**
 * Per-part switches for the automatic sync.
 *
 * The pass does several unrelated jobs on one timer, and the reason to stop one
 * is rarely a reason to stop the rest: pausing the manager forwarding while a
 * backlog is worked out should not also stop replies being pulled or campaign
 * windows being applied. Killing the whole timer to silence one part is the
 * only thing that was possible before, and it silently stopped campaigns from
 * starting on time.
 *
 * Stored rather than held in memory so a restart does not quietly turn a part
 * back on — someone who stopped the forwarding at five o'clock should not find
 * it running again because the server was restarted at six.
 */

export const SWITCHES = [
  {
    key: "sync.campaigns",
    label: "Campaign sync",
    /** What stops happening when it is off. */
    blurb:
      "Mirrors campaign stats and sending mailboxes from QuickMail each pass.",
    offWarning:
      "Dashboard figures and the sending-mailbox list will go stale, and deliverability warnings stop updating.",
  },
  {
    key: "sync.forward",
    label: "Send replies to the manager",
    blurb: "Forwards each new reply on to the manager, a few per pass.",
    offWarning:
      "Replies still arrive and are still classified — nothing is lost, they simply queue until this is switched back on.",
  },
] as const;

export type SwitchKey = (typeof SWITCHES)[number]["key"];

/**
 * Whether a part should run. Missing means on: a switch nobody has touched
 * must not be able to disable anything.
 */
export async function isOn(key: SwitchKey): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return row?.value !== "off";
}

export async function setSwitch(key: SwitchKey, on: boolean): Promise<void> {
  const value = on ? "on" : "off";
  await prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

export type SwitchState = {
  key: SwitchKey;
  label: string;
  blurb: string;
  offWarning: string;
  on: boolean;
  changedAt: string | null;
};

/** Every switch with its current state, for the Sync tab. */
export async function switchStates(): Promise<SwitchState[]> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: SWITCHES.map((s) => s.key) } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));

  return SWITCHES.map((s) => {
    const row = byKey.get(s.key);
    return {
      key: s.key,
      label: s.label,
      blurb: s.blurb,
      offWarning: s.offWarning,
      on: row?.value !== "off",
      changedAt: row?.updated_at.toISOString() ?? null,
    };
  });
}
