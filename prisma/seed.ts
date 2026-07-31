import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
});
const prisma = new PrismaClient({ adapter });

const LEADS = [
  {
    email: "sarah.chen@northwind.io",
    name: "Sarah Chen",
    first_name: "Sarah",
    last_name: "Chen",
    company: "Northwind Analytics",
    title: "VP Operations",
    status: "REPLIED" as const,
    ai_intent_score: 92,
  },
  {
    email: "marcus.webb@ferrolite.com",
    name: "Marcus Webb",
    first_name: "Marcus",
    last_name: "Webb",
    company: "Ferrolite Manufacturing",
    title: "Head of Procurement",
    status: "EMAILED" as const,
    ai_intent_score: 54,
  },
  {
    email: "priya.raman@lumenstack.dev",
    name: "Priya Raman",
    first_name: "Priya",
    last_name: "Raman",
    company: "LumenStack",
    title: "Director of RevOps",
    status: "REPLIED" as const,
    ai_intent_score: 78,
  },
  {
    email: "tom.oleary@bridgepoint.co",
    name: "Tom O'Leary",
    first_name: "Tom",
    last_name: "O'Leary",
    company: "Bridgepoint Capital",
    title: "Partner",
    status: "BOUNCED" as const,
    ai_intent_score: 0,
  },
  {
    email: "dana.kowalski@vertexhr.com",
    name: "Dana Kowalski",
    first_name: "Dana",
    last_name: "Kowalski",
    company: "Vertex HR",
    title: "Talent Lead",
    status: "UNCONTACTED" as const,
    ai_intent_score: 31,
  },
];

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@sybrant.com")
    .trim()
    .toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "changeme123";

  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: "Admin",
      role: "ADMIN",
      password_hash: await bcrypt.hash(password, 10),
    },
  });

  const template = await prisma.template.upsert({
    where: { id: "tmpl_intro" },
    update: {},
    create: {
      id: "tmpl_intro",
      name: "Cold Intro — Ops Teams",
      subject: "Quick question about {{companyName}}'s outbound",
      body: [
        "Hi {{firstName}},",
        "",
        "Noticed {{companyName}} has been scaling its GTM team — usually that means the reps are drowning in manual follow-up.",
        "",
        "We automate first-touch and reply triage so your team only talks to warm leads. Worth a 15-minute look?",
        "",
        "— Alex",
      ].join("\n"),
    },
  });

  const campaign = await prisma.campaign.upsert({
    where: { id: "camp_q3_outbound" },
    update: {},
    create: {
      id: "camp_q3_outbound",
      name: "Q3 Outbound — Mid-Market Ops",
      status: "ACTIVE",
      template_id: template.id,
    },
  });

  for (const lead of LEADS) {
    const record = await prisma.lead.upsert({
      where: { email: lead.email },
      update: {},
      create: { ...lead, source: "MOCK" },
    });

    if (lead.status === "UNCONTACTED") continue;

    await prisma.emailLog.create({
      data: {
        lead_id: record.id,
        campaign_id: campaign.id,
        type: "SENT",
        content: `Subject: Quick question about ${lead.company}'s outbound`,
      },
    });

    if (lead.status === "BOUNCED") {
      await prisma.emailLog.create({
        data: {
          lead_id: record.id,
          campaign_id: campaign.id,
          type: "BOUNCED",
          content: "550 5.1.1 recipient address rejected: user unknown",
        },
      });
    }

    if (lead.status === "REPLIED") {
      const positive = lead.ai_intent_score > 85;
      const content = positive
        ? "This is timely — we're re-evaluating our outbound stack this quarter. Can you send pricing and some availability next week?"
        : "Interested, though I'm not the decision maker. What does onboarding look like?";

      await prisma.emailLog.create({
        data: {
          lead_id: record.id,
          campaign_id: campaign.id,
          type: "REPLIED",
          content,
          sentiment: positive ? "MEETING_REQUEST" : "POSITIVE",
          sentiment_score: lead.ai_intent_score,
        },
      });

      // Seed the approval queue so the Approvals page has something to show.
      await prisma.approval.create({
        data: {
          type: positive ? "MEETING_BOOK" : "REPLY_SEND",
          lead_id: record.id,
          title: positive
            ? `Meeting request from ${lead.name}`
            : `Reply from ${lead.name}`,
          summary: positive
            ? "Asked for pricing and availability."
            : "Interested but not the decision maker.",
          ai_draft: positive
            ? `Hi ${lead.first_name},\n\nGreat timing. The short version on pricing: we start at $499/mo per sending domain, with volume tiers above that.\n\nGrab whichever slot suits you here: ${process.env.BOOKING_LINK ?? "[your booking link]"}\n\nBest,\nAlex`
            : `Hi ${lead.first_name},\n\nTotally understand. Onboarding is about a week: we connect your mailboxes, import your lists, and run a warm-up before anything goes out.\n\nHappy to send a one-pager you could forward on — useful?\n\nBest,\nAlex`,
          payload: JSON.stringify({ incoming: content }),
        },
      });
    }
  }

  const [leads, approvals] = await Promise.all([
    prisma.lead.count(),
    prisma.approval.count(),
  ]);

  console.log(
    `Seed complete — ${leads} leads, ${approvals} pending approvals.\n` +
      `Sign in: ${admin.email} / ${password}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
