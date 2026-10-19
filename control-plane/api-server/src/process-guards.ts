// P1-3: consolidated process crash guards.
// The API server previously registered TWO contradictory uncaughtException
// listeners (one that never exited, one that exited anyway) — the suppressor's
// intent was defeated by the second listener and every error was logged twice.
// One classifier, one listener, fail-closed: only known-benign errors survive,
// everything else logs once and process.exit(1).

export type UncaughtDisposition = "suppress" | "fatal";

export function isHeadersSentError(err: unknown): boolean {
  if (err instanceof Error) {
    if ((err as NodeJS.ErrnoException).code === "ERR_HTTP_HEADERS_SENT") return true;
    if (err.message.includes("ERR_HTTP_HEADERS_SENT")) return true;
    if (err.message.includes("headers have already been sent")) return true;
  }
  return false;
}

export function classifyUncaught(err: unknown): UncaughtDisposition {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_STREAM_WRITE_AFTER_END" || err.message.includes("write after end")) return "suppress";
    if (isHeadersSentError(err)) return "suppress";
    return "fatal";
  }
  return "fatal";
}

let installedException: ((err: Error) => void) | null = null;
let installedRejection: ((reason: unknown) => void) | null = null;

export function installProcessGuards(): void {
  if (installedException) process.removeListener("uncaughtException", installedException);
  if (installedRejection) process.removeListener("unhandledRejection", installedRejection);

  installedException = (err) => {
    if (classifyUncaught(err) === "suppress") {
      process.stderr.write(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        message: `Suppressed uncaught exception: ${err instanceof Error ? err.message : String(err)}`,
      }) + "\n");
      return;
    }
    process.stderr.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`,
      stack: err instanceof Error ? err.stack : undefined,
    }) + "\n");
    process.exit(1);
  };
  process.on("uncaughtException", installedException);

  installedRejection = (reason) => {
    if (isHeadersSentError(reason)) return;
    // eslint-disable-next-line no-console
    console.error("[ERROR] Unhandled rejection:", reason);
  };
  process.on("unhandledRejection", installedRejection);
}
