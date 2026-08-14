/**
 * Names for the actions in the activity log.
 *
 * Plain data in a plain module, because the Activity page is a client
 * component and the recorder next door imports Prisma and the session. Reading
 * a label through that module pulled better-sqlite3 into the browser bundle
 * and the build failed on `Can't resolve 'fs'`.
 */

export const ACTIONS = {
  "campaign.create": "Created a campaign",
  "campaign.trigger": "Set a campaign trigger",
  "reply.send": "Replied to a prospect",
  "reply.draft": "Generated a draft reply",
  "prospect.stop": "Stopped emailing a prospect",
  "thread.done": "Marked a reply handled",
  "thread.forward": "Forwarded a reply to the managers",
  "block.add": "Blocked an address or domain",
  "block.remove": "Unblocked an address or domain",
  "manager.add": "Added a manager",
  "manager.pause": "Paused or resumed a manager",
  "manager.remove": "Removed a manager",
  "template.save": "Saved a template",
  "approval.decide": "Decided an approval",
  "sync.switch": "Turned a sync job on or off",
} as const;

export type ActivityAction = keyof typeof ACTIONS;

export function actionLabel(action: string): string {
  return (ACTIONS as Record<string, string>)[action] ?? action;
}
