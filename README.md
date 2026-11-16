# slack-mcp

MCP server for Slack that acts as **you**, using your own browser session
(`xoxc` token + `d` cookie). No Slack app, no admin approval, works in any
workspace you're signed into.

Tools: `whoami`, `list_conversations`, `read_messages`, `read_thread`,
`send_message` (incl. your own DM via `"me"`), `edit_message`,
`add_reaction`, `remove_reaction`, `upload_file`, `confirm`, `cancel`,
`list_pending`, `search_messages`, `sync_directory`.

> **Preview gate: `send_message`, `edit_message`, `add_reaction`,
> `remove_reaction`, and `upload_file` only STAGE.** They validate, then
> return a preview + `action_id`. Nothing is posted, edited, reacted, or
> uploaded until `confirm(action_id)` runs — no exceptions, not even the
> self-DM. Staged actions expire after 5 minutes. Always show the preview
> to the human and wait for an explicit yes.

> **Group policy: staging into group DMs is refused unless you pass
> `confirm_group=true`.** 1:1 DMs, your own DM, and normal channels stage
> normally (but still need `confirm` to execute).

> Unofficial: this reuses Slack's web-client session. Slack can invalidate it
> (logout, password change, admin session reset) — just run `npm run login`
> again. Prefer an official Slack app for production/CI use.

## Setup (from a fresh clone)

Prerequisites: Node 18+ and npm. (If `npm install` fails against a private
registry, retry with the public one:
`npm install --registry=https://registry.npmjs.org`.)

```powershell
git clone https://github.com/Abhaycode42852/slack-mcp.git
cd slack-mcp
npm install
npm run build
npm run login
```

`npm run login` asks for two values from a Slack tab you're signed into:

1. **xoxc token** — F12 → Console. If it says "allow pasting", type that
   first, then run:
   ```js
   Object.values(JSON.parse(localStorage.localConfig_v2).teams)
     .map(t => t.name + " => " + t.token)
   ```
   Copy the `xoxc-...` value for your workspace.
2. **d cookie** — DevTools → Application → Cookies →
   `https://app.slack.com` → copy the Value of the cookie named `d`
   (starts with `xoxd-...`, keep it exactly as shown).

The values are validated with `auth.test` and saved to
`%USERPROFILE%\.config\slack-mcp\credentials.json` (Windows) or
`~/.config/slack-mcp/credentials.json` (macOS/Linux).
(Alternatively set `SLACK_XOXC_TOKEN` / `SLACK_XOXD_TOKEN` env vars, or copy
`.env.example` to `.env`.)

Everything else is automatic on first use: the built-in emoji catalog seeds
itself from `assets/emoji.json`, and `directory.json` (conversation/user
cache) builds on the first sync or lookup.

## Register in opencode

Add to the `mcp` section of your opencode config
(`%USERPROFILE%\.config\opencode\opencode.jsonc` on Windows,
`~/.config/opencode/opencode.jsonc` elsewhere), adjusting the paths to where
you cloned the repo. Restart opencode, then try `slack_whoami`:

```jsonc
"slack": {
  "type": "local",
  "enabled": true,
  "command": ["node", "<repo-path>/slack-mcp/dist/index.js"],
  "cwd": "<repo-path>/slack-mcp"
}
```

## Directory cache (fast lookups, low rate-limit use)

`directory.json` lives next to the credentials file and maps every
conversation + user to an id. Name lookups and `list_conversations` read this
file instead of paging Slack — instant, and no rate-limit burn.

```powershell
npm run sync                # quick: conversations + DM peers (default, gentle)
npm run cli -- sync full    # also pulls the whole user list (slow, Tier-2 limited)
npm run cli -- lookup vageesh   # resolve a person/channel from the cache
```

The file also **grows on its own**: every lookup persists what it used, so
only chats you actually touch accumulate. There is a matching
`sync_directory` MCP tool (`mode: "quick" | "full"`).

Re-run quick sync when channels/members change, or if a lookup says the cache
may be stale. Open-DM creation for a never-contacted person still costs one
live `conversations.open` call.

## Emoji catalog (no repeated web lookups)

`emoji.json` lives next to the credentials file: ~1980 built-in Slack
colon-names (from the iamcal emoji-data set) plus your workspace's custom
emoji (merged from `emoji.list` on every sync). Reaction calls check it
first; unknown names suggest alternatives (`:o:`, `:o2:`, …) instead of
failing blindly, and every live attempt writes its verdict back — so the
file only ever grows with names something actually used.

```powershell
npm run emoji:build            # (re)build from the iamcal set; keeps custom + verdicts
npm run cli -- emoji thumbsup  # check the local catalog
```

Note: Slack's built-in set has **no regional-indicator letters** (that's why
`regional_indicator_o` fails) — for "O" use `:o2:` 🅾️, for "C" use
`:copyright:` ©️, or add custom letter emoji in workspace settings.

## Smoke test without an MCP client

```powershell
npm run cli -- whoami
npm run cli -- list standup
npm run cli -- read me 5
npm run cli -- send me "hello from slack-mcp"  # stages only
npm run cli -- pending                         # review staged actions
npm run cli -- confirm <action_id>             # executes
npm run cli -- cancel <action_id>              # discards
npm run cli -- upload me ./report.pdf "Q3 summary"  # stages a file upload
npm run cli -- edit me <ts> "fixed version"
npm run cli -- react me <ts> thumbsup
npm run cli -- search "deploy"
```

## Formatting outgoing messages

Plain `text` supports Slack mrkdwn: `*bold*` `_italic_` `~strike~`
`` `code` `` fenced ` ```lang ... ``` ` blocks, `<https://url|label>` links,
`> quotes`, `- bullets`, `1. numbered lists`.

For rich layouts pass `blocks_json`: a JSON array of Block Kit blocks
(`header`, `section` with `mrkdwn`, `divider`, `context`, `image`). Keep
`text` filled in — it is the fallback/notification text. Large logs,
tables, or code go either in a fenced section block or as an attached file
via `upload_file` (3-step external upload, max 200 MB), which renders
inline in the message.

## Notes

- Local data lives in `%USERPROFILE%\.config\slack-mcp\` (Windows) or
  `~/.config/slack-mcp/` (macOS/Linux): `credentials.json`, `directory.json`
  (conversation/user cache), `emoji.json` (catalog + workspace custom emoji),
  `pending.json` (staged actions), `audit.jsonl`. None of these are committed
  — the repo only ships the built-in seed at `assets/emoji.json`.
- Every stage and confirm is appended to `audit.jsonl`.
- Staged actions live in `pending.json` and die after 5 minutes; confirms are
  single-use (re-confirming an id fails — stage again).
- `chat.update` only edits your own messages (Slack rule); messages with
  file attachments may refuse edits.
- Free-tier workspaces expose limited history (~90 days).
- If calls start failing with auth errors, re-run `npm run login`.
