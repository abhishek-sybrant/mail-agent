/**
 * Starts the automatic sync with the server.
 *
 * `register()` runs once per server instance and must finish before requests
 * are served, so this only arms a timer — it never syncs here. Putting the
 * first pass on the boot path would hold the server closed for the length of
 * a lead walk.
 *
 * Living in the app process rather than a second terminal is deliberate: the
 * reply pull drives a browser session over CDP, which the Next.js process
 * already knows how to do, and `npm run serve` is the only thing anyone has to
 * remember to start. Set SYNC_AUTO=false to turn it off.
 */
export async function register() {
  // Edge has no timers worth arming and no database adapter — Node only.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SYNC_AUTO === "false") {
    console.log("[sync] automatic sync disabled by SYNC_AUTO=false");
    return;
  }

  const { startSyncTicker } = await import("@/lib/sync/ticker");
  startSyncTicker();
}
