/**
 * Interactive first-run setup: paste your browser session pair and it gets
 * validated with auth.test, then stored in
 * %USERPROFILE%\.config\slack-mcp\credentials.json
 *
 * Run: npm run login
 */
import { createInterface } from "readline";
import { authTest } from "./slack.js";
import {
  auditFilePath,
  credentialsFilePath,
  saveCredentials,
  type SlackCredentials,
} from "./credentials.js";
import { loadEnvFile } from "./load-env.js";

loadEnvFile();

function clean(value: string): string {
  let v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function ask(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(clean(answer)));
  });
}

async function main(): Promise<void> {
  console.log(`
Slack MCP login
===============
This stores YOUR browser session so the MCP server can act as you.
No Slack app, no admin approval.

1. Open https://app.slack.com in Chrome/Edge and sign in to your workspace.
2. Press F12 -> Console tab. If it says "allow pasting", type that first.
   Then run:
     Object.values(JSON.parse(localStorage.localConfig_v2).teams)
       .map(t => t.name + " => " + t.token)
   Copy the xoxc-... token for your workspace.
3. Still in DevTools: Application -> Cookies -> https://app.slack.com
   Copy the Value of the cookie named "d" (starts with xoxd-...).
   Paste values below (right-click in this window to paste).
`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const xoxc = await ask(rl, "xoxc token (xoxc-...): ");
  if (!xoxc.startsWith("xoxc-")) {
    console.error("That does not look like an xoxc token (expected prefix xoxc-...). Aborting.");
    rl.close();
    process.exit(1);
  }

  const xoxd = await ask(rl, "d cookie value (xoxd-...): ");
  if (!xoxd.startsWith("xoxd-")) {
    console.error("That does not look like a d cookie (expected prefix xoxd-...). Aborting.");
    rl.close();
    process.exit(1);
  }

  const cookieName = (await ask(rl, "Cookie name [d]: ")) || "d";
  rl.close();

  const draft: SlackCredentials = {
    team_id: "",
    team_name: "",
    user_id: "",
    user: "",
    xoxc,
    xoxd,
    cookie_name: cookieName,
  };

  console.log("Validating against Slack (auth.test)...");
  try {
    const info = await authTest(draft);
    draft.team_id = info.team_id;
    draft.team_name = info.team;
    draft.user_id = info.user_id;
    draft.user = info.user;
    saveCredentials(draft);
    console.log(`
OK — signed in as ${info.user} in workspace "${info.team}".
Credentials saved to: ${credentialsFilePath()}
Every send/edit is logged to: ${auditFilePath()}

Next: register the server in opencode and restart it, then try "slack_whoami".
When Slack rejects the session one day (logout / session reset),
just run "npm run login" again.`);
  } catch (error) {
    console.error(
      `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("Nothing was saved. Check the pasted values and try again.");
    process.exit(1);
  }
}

main();
