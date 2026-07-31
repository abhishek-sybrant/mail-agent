import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/leads/import
 *
 * Mock CSV import. Generates a small batch of plausible leads so the dashboard
 * has something to work with; replace with a real file parser later.
 */
const MOCK_POOL = [
  { name: "Elena Petrova", company: "Halcyon Logistics", domain: "halcyon.co" },
  { name: "Devon Brooks", company: "Ridgeline Media", domain: "ridgeline.tv" },
  { name: "Aisha Nkemdi", company: "Solace Health", domain: "solacehealth.io" },
  { name: "Jonas Meyer", company: "Kessler Robotics", domain: "kesslerbot.de" },
  { name: "Ruth Alvarez", company: "Cobalt Freight", domain: "cobaltfreight.com" },
  { name: "Simon Fairbanks", company: "Arbor Legal", domain: "arborlegal.uk" },
];

export async function POST() {
  const stamp = Date.now().toString(36).slice(-4);

  const candidates = MOCK_POOL.map((p) => {
    const handle = p.name.toLowerCase().replace(/[^a-z]+/g, ".");
    return {
      email: `${handle}.${stamp}@${p.domain}`,
      name: p.name,
      company: p.company,
      ai_intent_score: 10 + ((p.name.length * 7) % 45),
    };
  });

  const result = await prisma.lead.createMany({ data: candidates });

  return NextResponse.json({ ok: true, imported: result.count });
}
