import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(PROJECT_ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "mcp-startup.log");

export function debugLog(message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;

  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    // Ignore logging failures.
  }
}

export function getLogFilePath() {
  return LOG_FILE;
}
