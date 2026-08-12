/**
 * Starts the production server and prints addresses that can actually be opened.
 *
 *   npm run serve
 *
 * Next.js binds to 0.0.0.0 to listen on every interface, then prints
 * "Network: http://0.0.0.0:3000" as though that were a URL. It is not — 0.0.0.0
 * is a bind instruction, and a browser sent there returns ERR_ADDRESS_INVALID.
 * This prints the real LAN address instead, so the thing on screen is the thing
 * to click.
 */
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = process.env.PORT ?? "3000";

/** Every IPv4 address on this machine that another machine could reach. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      // Link-local addresses are self-assigned and never routable.
      if (a.address.startsWith("169.254.")) continue;
      out.push(`${a.address}  (${name})`);
    }
  }
  return out;
}

if (!existsSync(path.join(process.cwd(), ".next"))) {
  console.error("No production build found. Run `npm run build` first.");
  process.exit(1);
}

const lan = lanAddresses();
console.log("\n  AI SDR Dashboard — production build\n");
console.log(`  On this machine   http://localhost:${PORT}`);
if (lan.length) {
  console.log(`  From another PC   http://${lan[0].split("  ")[0]}:${PORT}`);
  for (const extra of lan.slice(1)) {
    console.log(`                    http://${extra.split("  ")[0]}:${PORT}   ${extra.split("  ")[1]}`);
  }
} else {
  console.log("  From another PC   (no network address found)");
}
console.log("\n  Do NOT browse to 0.0.0.0 — it is a bind address, not a URL.");
console.log("  If another machine cannot connect, allow TCP " + PORT + " inbound on the private profile.\n");

// -H 0.0.0.0 is still correct: it is how the server listens on every interface.
const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["next", "start", "-H", "0.0.0.0", "-p", PORT],
  { stdio: "inherit", shell: process.platform === "win32" },
);
child.on("exit", (code) => process.exit(code ?? 0));
