import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface SlackCredentials {
  team_id: string;
  team_name: string;
  user_id: string;
  user: string;
  /** xoxc-... session token for the workspace */
  xoxc: string;
  /** Value of the `d` cookie (xoxd-...) shared by all workspaces on the login */
  xoxd: string;
  /** Cookie name, almost always "d" */
  cookie_name: string;
}

const CREDS_DIR = join(homedir(), ".config", "slack-mcp");
export const CREDS_FILE = join(CREDS_DIR, "credentials.json");
export const AUDIT_FILE = join(CREDS_DIR, "audit.jsonl");

const LOGIN_HINT =
  "Slack credentials not found. Run `npm run login` in the slack-mcp folder " +
  "and paste your xoxc token and d cookie, or set SLACK_XOXC_TOKEN and " +
  "SLACK_XOXD_TOKEN environment variables.";

function required(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function credentialsFilePath(): string {
  return CREDS_FILE;
}

export function configDir(): string {
  return CREDS_DIR;
}

export function auditFilePath(): string {
  return AUDIT_FILE;
}

export function loadCredentials(): SlackCredentials {
  const envXoxc = process.env.SLACK_XOXC_TOKEN?.trim();
  const envXoxd = process.env.SLACK_XOXD_TOKEN?.trim();

  if (envXoxc || envXoxd) {
    if (!required(envXoxc) || !required(envXoxd)) {
      throw new Error(
        "Both SLACK_XOXC_TOKEN and SLACK_XOXD_TOKEN must be set. " + LOGIN_HINT,
      );
    }
    return {
      team_id: process.env.SLACK_TEAM_ID ?? "",
      team_name: "",
      user_id: process.env.SLACK_USER_ID ?? "",
      user: "",
      xoxc: envXoxc,
      xoxd: envXoxd,
      cookie_name: process.env.SLACK_COOKIE_NAME?.trim() || "d",
    };
  }

  if (!existsSync(CREDS_FILE)) {
    throw new Error(LOGIN_HINT);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(CREDS_FILE, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error(
      `Could not parse ${CREDS_FILE}. Re-run \`npm run login\` to recreate it.`,
    );
  }

  if (!required(parsed.xoxc) || !required(parsed.xoxd)) {
    throw new Error(
      `Incomplete credentials in ${CREDS_FILE}. Re-run \`npm run login\`.`,
    );
  }

  return {
    team_id: typeof parsed.team_id === "string" ? parsed.team_id : "",
    team_name: typeof parsed.team_name === "string" ? parsed.team_name : "",
    user_id: typeof parsed.user_id === "string" ? parsed.user_id : "",
    user: typeof parsed.user === "string" ? parsed.user : "",
    xoxc: (parsed.xoxc as string).trim(),
    xoxd: (parsed.xoxd as string).trim(),
    cookie_name:
      typeof parsed.cookie_name === "string" && parsed.cookie_name.trim()
        ? (parsed.cookie_name as string).trim()
        : "d",
  };
}

export function saveCredentials(creds: SlackCredentials): void {
  mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2) + "\n", "utf8");
}

/** One audit line per write action. Never logs tokens. */
export function audit(action: string, summary: Record<string, unknown>): void {
  try {
    mkdirSync(CREDS_DIR, { recursive: true });
    appendFileSync(
      AUDIT_FILE,
      JSON.stringify({ at: new Date().toISOString(), action, ...summary }) +
        "\n",
      "utf8",
    );
  } catch {
    // Audit must never break a send.
  }
}
