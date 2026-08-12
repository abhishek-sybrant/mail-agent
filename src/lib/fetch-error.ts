/**
 * Turns a failed fetch into something worth reading.
 *
 * When the server is not reachable — restarted, stopped, or the machine went
 * to sleep — browsers reject with a bare TypeError whose message is "Failed to
 * fetch" (Chrome and Edge), "NetworkError when attempting to fetch resource"
 * (Firefox) or "Load failed" (Safari). Shown as-is, that reads like a bug in
 * the page and sends people looking in the wrong place; the actual answer is
 * almost always that the app is not running.
 *
 * Errors the server did answer with are passed through untouched — those carry
 * a real explanation and must not be replaced by a guess about the network.
 */
export function fetchErrorMessage(error: unknown, fallback = "Failed"): string {
  if (!(error instanceof Error)) return fallback;

  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const isNetwork =
    error.name === "TypeError" &&
    /failed to fetch|networkerror|load failed|network request failed/i.test(
      error.message,
    );

  if (offline) return "No network connection.";
  if (isNetwork) {
    return "Can't reach the server — check it is still running, then try again.";
  }

  return error.message || fallback;
}
