import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { loadEnvFile } from "./load-env.js";
import { debugLog, getLogFilePath } from "./debug-log.js";
import { audit, loadCredentials, type SlackCredentials } from "./credentials.js";
import { lookupEmoji, normalizeEmojiName, suggestEmoji } from "./emoji.js";
import {
  cancelPending,
  formatPreview,
  listPending,
  restagePending,
  stagePending,
  takePending,
  type PendingEntry,
} from "./pending.js";
import {
  addReaction,
  authTest,
  editMessage,
  formatMessages,
  formatSearchHit,
  friendlyErrorHint,
  inspectUploadFile,
  listConversations,
  readDirectory,
  readHistory,
  readThread,
  removeReaction,
  resolveChannel,
  searchMessages,
  sendMessage,
  SlackError,
  syncDirectory,
  uploadFile,
  type ResolvedChannel,
} from "./slack.js";

/**
 * Everything that posts, edits, reacts, or uploads goes through staging:
 * the tool records the exact payload and returns a preview + action_id.
 * Only confirm() executes, and it runs the stored payload verbatim — it
 * takes no text/emoji/file arguments, so the previewed thing is provably
 * the sent thing. No exemptions, not even the self-DM.
 */
function parseBlocksJson(blocksJson?: string): unknown[] | undefined {
  if (blocksJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(blocksJson);
  } catch {
    throw new SlackError("blocks", "invalid_json", "blocks_json is not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new SlackError(
      "blocks",
      "not_an_array",
      "blocks_json must be a non-empty JSON array of Block Kit blocks.",
    );
  }
  if (parsed.length > 50) {
    throw new SlackError("blocks", "too_many", "Slack allows at most 50 blocks per message.");
  }
  return parsed;
}

function errorText(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

async function executePending(
  creds: SlackCredentials,
  entry: PendingEntry,
): Promise<string> {
  switch (entry.action) {
    case "send": {
      const result = await sendMessage(creds, entry.channel_id, entry.text ?? "", {
        thread_ts: entry.thread_ts,
        unfurl_links: entry.unfurl_links === true,
        blocks: entry.blocks,
      });
      audit("send_message", {
        action_id: entry.id,
        channel: result.channel,
        ts: result.ts,
        thread_ts: entry.thread_ts ?? null,
        chars: (entry.text ?? "").length,
        blocks: entry.blocks?.length ?? 0,
      });
      return (
        `Sent to ${entry.channel_label}:\nchannel=${result.channel}\nts=${result.ts}` +
        `\n(keep the ts to edit this message or add a reaction later)`
      );
    }
    case "edit": {
      const result = await editMessage(creds, entry.channel_id, entry.ts ?? "", entry.text ?? "", {
        blocks: entry.blocks,
      });
      audit("edit_message", {
        action_id: entry.id,
        channel: result.channel,
        ts: result.ts,
        chars: (entry.text ?? "").length,
      });
      return `Edited in ${entry.channel_label}:\nchannel=${result.channel}\nts=${result.ts}`;
    }
    case "reaction": {
      await addReaction(creds, entry.channel_id, entry.ts ?? "", entry.emoji ?? "");
      audit("add_reaction", {
        action_id: entry.id,
        channel: entry.channel_id,
        ts: entry.ts,
        emoji: entry.emoji,
      });
      return `Added :${entry.emoji}: to message ${entry.ts} in ${entry.channel_label}.`;
    }
    case "unreact": {
      await removeReaction(creds, entry.channel_id, entry.ts ?? "", entry.emoji ?? "");
      audit("remove_reaction", {
        action_id: entry.id,
        channel: entry.channel_id,
        ts: entry.ts,
        emoji: entry.emoji,
      });
      return `Removed :${entry.emoji}: from message ${entry.ts} in ${entry.channel_label}.`;
    }
    case "upload": {
      const result = await uploadFile(creds, entry.channel_id, entry.file_path ?? "", {
        filename: entry.file_name,
        title: entry.file_title,
        initialComment: entry.text,
        threadTs: entry.thread_ts,
      });
      audit("upload_file", {
        action_id: entry.id,
        channel: result.channel,
        ts: result.ts,
        file_id: result.file_id,
        bytes: entry.file_bytes,
      });
      return (
        `Uploaded ${entry.file_name} to ${entry.channel_label}:\nchannel=${result.channel}` +
        (result.ts ? `\nts=${result.ts} (keep it to edit the comment or add a reaction)` : `\nfile_id=${result.file_id}`) +
        `\n(the initial comment can be edited later via edit_message if ts is shown)`
      );
    }
  }
}

debugLog("process starting");

process.on("uncaughtException", (error) => {
  debugLog(`uncaughtException: ${error.stack ?? error.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  debugLog(`unhandledRejection: ${String(reason)}`);
  process.exit(1);
});

try {
  loadEnvFile();
  debugLog("env file loaded");
} catch (error) {
  debugLog(`env load failed: ${String(error)}`);
  throw error;
}

// Credentials load lazily so the server always boots (and lists its tools)
// even before `npm run login` has been done. Each tool then fails with the
// login hint instead of the whole server refusing to start.
let cachedCreds: SlackCredentials | null = null;

function getCreds(): SlackCredentials {
  if (!cachedCreds) {
    cachedCreds = loadCredentials();
    debugLog("credentials loaded");
  }
  return cachedCreds;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(error: unknown) {
  const text =
    error instanceof SlackError
      ? friendlyErrorHint(error)
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/**
 * Group-DM policy: refuses to put text into a group DM / multi-party DM
 * unless the caller passes confirm_group=true. Private channels (G ids that
 * are not mpim) are unaffected.
 */
function groupGuard(
  resolved: ResolvedChannel,
  confirmGroup: boolean,
  verb: string,
): string | null {
  if (resolved.kind === "mpim" && !confirmGroup) {
    return (
      `Refusing to ${verb} ${resolved.label} (${resolved.id}): it is a group DM, ` +
      `and group sends are disabled. Say explicitly that the group is OK — ` +
      `or retry with confirm_group=true.`
    );
  }
  if (resolved.kind === "unknown" && resolved.id.startsWith("G") && !confirmGroup) {
    return (
      `Refusing to ${verb} ${resolved.id}: its kind could not be determined ` +
      `(private channel or group DM?). Run sync_directory first, or retry ` +
      `with confirm_group=true.`
    );
  }
  return null;
}

const server = new McpServer({ name: "slack-mcp", version: "1.0.0" });

server.registerTool(
  "whoami",
  {
    description:
      "Check who the Slack session belongs to (team, user) and verify the credentials still work. Also returns your own-DM channel id. Call this first when auth looks broken.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const info = await authTest(getCreds());
      let selfDm: string | null = null;
      try {
        selfDm = (await resolveChannel(getCreds(), "me")).id;
      } catch {
        // auth is fine, self-DM just could not be opened
      }
      return textResult(JSON.stringify({ ...info, self_dm: selfDm }, null, 2));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "list_conversations",
  {
    description:
      "List conversations you belong to (channels, private channels, DMs, group DMs). Use the id from here with the other tools. Filter with query (matches name/label), e.g. \"standup\" or \"Priya\".",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .optional()
        .describe("Filter by name/label, e.g. \"standup\". Leave empty to list all."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Max conversations to return (default 50)."),
    }),
  },
  async ({ query, limit }) => {
    try {
      const dir = readDirectory();
      if (dir) {
        const lowered = query?.toLowerCase();
        const str = (v: unknown): string => (typeof v === "string" ? v : "");
        const items = (
          lowered
            ? dir.conversations.filter(
                (c) =>
                  str(c.label).toLowerCase().includes(lowered) ||
                  str(c.name).toLowerCase().includes(lowered) ||
                  c.id === query,
              )
            : dir.conversations
        ).slice(0, limit);
        const lines = items.map(
          (c) =>
            `${c.label} (${c.id})${c.num_members ? ` · ${c.num_members} members` : ""}${c.is_archived ? " · archived" : ""}`,
        );
        return textResult(
          `${items.length} of ${dir.conversations.length} conversation(s)` +
            (query ? ` matching "${query}"` : "") +
            ` (cached ${dir.synced_at} — run sync_directory to refresh):\n` +
            (lines.join("\n") || "(none)"),
        );
      }
      const all = await listConversations(getCreds());
      const lowered = query?.toLowerCase();
      const items = (lowered
        ? all.filter(
            (c) => c.label.toLowerCase().includes(lowered) || c.id === query,
          )
        : all
      ).slice(0, limit);
      const lines = items.map(
        (c) =>
          `${c.label} (${c.id})${c.num_members ? ` · ${c.num_members} members` : ""}${c.is_archived ? " · archived" : ""}`,
      );
      return textResult(
        `${items.length} of ${all.length} conversation(s)` +
          (query ? ` matching "${query}"` : "") +
          ":\n" +
          (lines.join("\n") || "(none)"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "read_messages",
  {
    description:
      "Read recent messages from a channel, DM, or your own DM. Channel accepts an id (C.../D...), #name, plain name, @user (their DM), or \"me\". Returns newest-first with each message's ts — pass that ts to edit_message / add_reaction. Use cursor to page further back.",
    inputSchema: z.object({
      channel: z
        .string()
        .min(1)
        .describe("Channel id, #name, name, @user for their DM, or \"me\"."),
      limit: z.number().int().min(1).max(200).default(20).describe("Messages to return (default 20, max 200)."),
      oldest: z.string().optional().describe("Only messages after this ts."),
      latest: z.string().optional().describe("Only messages before this ts."),
      cursor: z.string().optional().describe("next_cursor from a previous call to page back."),
    }),
  },
  async ({ channel, limit, oldest, latest, cursor }) => {
    try {
      const resolved = await resolveChannel(getCreds(), channel);
      const page = await readHistory(getCreds(), resolved.id, { limit, oldest, latest, cursor });
      const body = await formatMessages(getCreds(), page.messages, { reverse: true });
      const more = page.has_more
        ? `\n\n[more available — call again with cursor "${page.next_cursor}"]`
        : "";
      return textResult(`# ${resolved.label} (${resolved.id})\n\n${body}${more}`);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "read_thread",
  {
    description:
      "Read all replies in one thread. thread_ts is the ts of the parent message (visible in read_messages output, messages with a reply count).",
    inputSchema: z.object({
      channel: z.string().min(1).describe("Same channel forms as read_messages."),
      thread_ts: z.string().min(1).describe("Timestamp of the thread's parent message."),
      limit: z.number().int().min(1).max(200).default(100).describe("Replies to return (default 100)."),
      cursor: z.string().optional().describe("next_cursor from a previous call."),
    }),
  },
  async ({ channel, thread_ts, limit, cursor }) => {
    try {
      const resolved = await resolveChannel(getCreds(), channel);
      const page = await readThread(getCreds(), resolved.id, thread_ts, { limit, cursor });
      const body = await formatMessages(getCreds(), page.messages);
      const more = page.has_more
        ? `\n\n[more available — call again with cursor "${page.next_cursor}"]`
        : "";
      return textResult(`# ${resolved.label} — thread ${thread_ts}\n\n${body}${more}`);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "send_message",
  {
    description:
      "STAGE a message (does NOT send). Validates the channel and formatting, then returns a preview with an action_id. Nothing is posted until confirm(action_id) runs with the human's explicit go-ahead — always show the preview and wait. Staged sends expire after 5 minutes. Formatting: plain text supports Slack mrkdwn (*bold* _italic_ ~strike~ `code` ```code block``` <https://url|label> links, > quote, - bullets, 1. numbered). For rich layouts pass blocks_json: a JSON array of Block Kit blocks (header, section with mrkdwn text, divider, context, image). text is still required as the fallback/notification text.",
    inputSchema: z.object({
      channel: z.string().min(1).describe("Channel id, #name, name, @user, or \"me\"."),
      text: z.string().min(1).max(4000).describe("Message text (max ~4000 chars, mrkdwn ok)."),
      thread_ts: z.string().optional().describe("Reply inside this thread instead of the channel."),
      unfurl_links: z.boolean().default(false).describe("Let Slack expand link previews."),
      blocks_json: z
        .string()
        .optional()
        .describe(
          "Optional JSON array of Slack Block Kit blocks (header/section/divider/context). Large code or tables go in a ``` fenced block inside a section's mrkdwn text, or as an attached file via upload_file.",
        ),
      confirm_group: z
        .boolean()
        .default(false)
        .describe("Required true to stage a send into a group DM. Leave false for 1:1 DMs and channels."),
    }),
  },
  async ({ channel, text, thread_ts, unfurl_links, blocks_json, confirm_group }) => {
    try {
      const resolved = await resolveChannel(getCreds(), channel);
      const blocked = groupGuard(resolved, confirm_group, "send to");
      if (blocked) {
        return { content: [{ type: "text" as const, text: blocked }], isError: true as const };
      }
      const blocks = parseBlocksJson(blocks_json);
      const staged = stagePending({
        action: "send",
        channel_id: resolved.id,
        channel_label: resolved.label,
        kind: resolved.kind,
        text,
        blocks,
        thread_ts,
        unfurl_links: unfurl_links === true,
      });
      audit("stage_send", {
        action_id: staged.id,
        channel: resolved.id,
        chars: text.length,
        blocks: blocks?.length ?? 0,
      });
      return textResult(
        `STAGED — nothing sent yet. Show this preview to the human and wait for confirmation.\n\n${formatPreview(staged)}`,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "edit_message",
  {
    description:
      "STAGE an edit (does NOT apply it). Only your own messages can be edited (Slack rule). Get channel + ts from send_message or read_messages output. Returns a preview with an action_id; nothing changes until confirm(action_id) runs with the human's explicit go-ahead. Staged edits expire after 5 minutes. text supports Slack mrkdwn; blocks_json optionally replaces the message's Block Kit blocks.",
    inputSchema: z.object({
      channel: z.string().min(1).describe("Same channel forms as read_messages."),
      ts: z.string().min(1).describe("Timestamp of the message to edit."),
      text: z.string().min(1).max(4000).describe("Replacement text (max ~4000 chars)."),
      blocks_json: z
        .string()
        .optional()
        .describe("Optional JSON array of Block Kit blocks replacing the message layout."),
      confirm_group: z
        .boolean()
        .default(false)
        .describe("Required true to stage an edit inside a group DM."),
    }),
  },
  async ({ channel, ts, text, blocks_json, confirm_group }) => {
    try {
      const resolved = await resolveChannel(getCreds(), channel);
      const blocked = groupGuard(resolved, confirm_group, "edit messages in");
      if (blocked) {
        return { content: [{ type: "text" as const, text: blocked }], isError: true as const };
      }
      const blocks = parseBlocksJson(blocks_json);
      const staged = stagePending({
        action: "edit",
        channel_id: resolved.id,
        channel_label: resolved.label,
        kind: resolved.kind,
        text,
        blocks,
        ts,
      });
      audit("stage_edit", { action_id: staged.id, channel: resolved.id, ts, chars: text.length });
      return textResult(
        `STAGED — nothing changed yet. Show this preview to the human and wait for confirmation.\n\n${formatPreview(staged)}`,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "add_reaction",
  {
    description:
      "STAGE a reaction (does NOT add it). The name is checked against the local emoji catalog first; unknown names suggest alternatives instead of failing blindly. Get channel + ts from send_message or read_messages output. Returns a preview with an action_id; nothing happens until confirm(action_id) runs. Staged reactions expire after 5 minutes.",
    inputSchema: z.object({
      channel: z.string().min(1).describe("Same channel forms as read_messages."),
      ts: z.string().min(1).describe("Timestamp of the message."),
      emoji: z.string().min(1).describe("Emoji name without colons, e.g. \"thumbsup\"."),
    }),
  },
  async ({ channel, ts, emoji }) => {
    try {
      const resolved = await resolveChannel(getCreds(), channel);
      // Fast-fail known-bad names with suggestions before staging.
      // (Live validation of new names still happens at confirm time.)
      const name = normalizeEmojiName(emoji);
      const known = lookupEmoji(name);
      if (known && known.slack === "no") {
        const suggestions = suggestEmoji(name);
        return errorText(
          `"${emoji}" is not a Slack emoji.` +
            (suggestions.length ? ` Did you mean: ${suggestions.map((s) => `:${s}:`).join(" ")}?` : ""),
        );
      }
      const staged = stagePending({
        action: "reaction",
        channel_id: resolved.id,
        channel_label: resolved.label,
        kind: resolved.kind,
        ts,
        emoji: name,
        emoji_char: known?.char,
      });
      audit("stage_reaction", { action_id: staged.id, channel: resolved.id, ts, emoji: name });
      return textResult(
        `STAGED — nothing added yet. Show this preview to the human and wait for confirmation.\n\n${formatPreview(staged)}`,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "remove_reaction",
  {
    description: "STAGE a reaction removal (does NOT remove it). Returns a preview with an action_id; nothing happens until confirm(action_id) runs. Staged removals expire after 5 minutes.",
    inputSchema: z.object({
      channel: z.string().min(1).describe("Same channel forms as read_messages."),
      ts: z.string().min(1).describe("Timestamp of the message."),
      emoji: z.string().min(1).describe("Emoji name without colons, e.g. \"thumbsup\"."),
    }),
  },
  async ({ channel, ts, emoji }) => {
    try {
      const resolved = await resolveChannel(getCreds(), channel);
      const name = normalizeEmojiName(emoji);
      const known = lookupEmoji(name);
      const staged = stagePending({
        action: "unreact",
        channel_id: resolved.id,
        channel_label: resolved.label,
        kind: resolved.kind,
        ts,
        emoji: name,
        emoji_char: known?.char,
      });
      audit("stage_unreact", { action_id: staged.id, channel: resolved.id, ts, emoji: name });
      return textResult(
        `STAGED — nothing removed yet. Show this preview to the human and wait for confirmation.\n\n${formatPreview(staged)}`,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "upload_file",
  {
    description:
      "STAGE a file upload (does NOT upload). Reads a local file and shares it into a channel/DM with an optional mrkdwn comment. Validates path and size (max 200 MB), then returns a preview with an action_id; nothing is uploaded until confirm(action_id) runs with the human's explicit go-ahead. Staged uploads expire after 5 minutes.",
    inputSchema: z.object({
      channel: z.string().min(1).describe("Channel id, #name, name, @user, or \"me\"."),
      path: z.string().min(1).describe("Absolute local file path to upload."),
      comment: z
        .string()
        .max(4000)
        .optional()
        .describe("Optional initial comment posted with the file (mrkdwn ok)."),
      filename: z
        .string()
        .optional()
        .describe("Override the filename shown in Slack (defaults to the file's own name)."),
      title: z.string().optional().describe("Optional title shown on the file."),
      thread_ts: z.string().optional().describe("Share the file inside a thread instead of the channel."),
      confirm_group: z
        .boolean()
        .default(false)
        .describe("Required true to stage an upload into a group DM."),
    }),
  },
  async ({ channel, path, comment, filename, title, thread_ts, confirm_group }) => {
    try {
      const resolved = await resolveChannel(getCreds(), channel);
      const blocked = groupGuard(resolved, confirm_group, "upload to");
      if (blocked) {
        return { content: [{ type: "text" as const, text: blocked }], isError: true as const };
      }
      const info = inspectUploadFile(path, filename);
      const staged = stagePending({
        action: "upload",
        channel_id: resolved.id,
        channel_label: resolved.label,
        kind: resolved.kind,
        text: comment,
        file_path: info.path,
        file_name: info.name,
        file_title: title,
        file_bytes: info.bytes,
        thread_ts,
      });
      audit("stage_upload", {
        action_id: staged.id,
        channel: resolved.id,
        path: info.path,
        bytes: info.bytes,
      });
      return textResult(
        `STAGED — nothing uploaded yet. Show this preview to the human and wait for confirmation.\n\n${formatPreview(staged)}`,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "confirm",
  {
    description:
      "Execute one staged action_id exactly as previewed. Takes NO text/emoji/file arguments — the stored payload runs verbatim, so the previewed thing is provably the sent thing. Single-use; fails if the 5-minute staging expired. If execution fails, the payload is re-staged under a fresh id so it can be retried.",
    inputSchema: z.object({
      action_id: z.string().min(1).describe("The id from a stage preview, e.g. \"a1b2c3d4\"."),
    }),
  },
  async ({ action_id }) => {
    try {
      const entry = takePending(action_id.trim());
      if (!entry) {
        const pending = listPending();
        return errorText(
          `No pending action "${action_id}" (unknown, already confirmed/cancelled, or expired after 5 min). Stage it again.` +
            (pending.length > 0
              ? `\nCurrently pending: ${pending.map((p) => `${p.id} (${p.action} to ${p.channel_label})`).join("; ")}`
              : "\nNothing is currently pending."),
        );
      }
      try {
        return textResult(await executePending(getCreds(), entry));
      } catch (error) {
        const { id, created_at, expires_at, ...rest } = entry;
        void id;
        void created_at;
        void expires_at;
        const retry = restagePending(rest);
        const hint =
          error instanceof SlackError
            ? friendlyErrorHint(error)
            : error instanceof Error
              ? error.message
              : String(error);
        return errorText(
          `Confirm failed: ${hint}\nRe-staged as ${retry.id} (expires in 5 min). Confirm ${retry.id} to retry, or cancel it.`,
        );
      }
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "cancel",
  {
    description: "Discard one staged action_id without executing it.",
    inputSchema: z.object({
      action_id: z.string().min(1).describe("The id from a stage preview."),
    }),
  },
  async ({ action_id }) => {
    try {
      const entry = cancelPending(action_id.trim());
      if (!entry) {
        return errorText(`No pending action "${action_id}". Nothing to cancel.`);
      }
      audit("cancel", { action_id: entry.id, action: entry.action, channel: entry.channel_id });
      return textResult(`Cancelled ${entry.action} ${entry.id} to ${entry.channel_label}. Nothing was sent.`);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "list_pending",
  {
    description: "List staged actions awaiting confirm, with time left before each expires.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const pending = listPending();
      if (pending.length === 0) return textResult("Nothing is currently pending.");
      return textResult(pending.map((p) => formatPreview(p)).join("\n\n---\n\n"));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "search_messages",
  {
    description:
      "Full-text search across messages you can see (channels, DMs, threads). Supports Slack query syntax like \"from:@priya in:#standup\". May be limited on some workspaces — if it fails, use list_conversations + read_messages instead.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Search query, e.g. \"deploy freeze\" or \"from:@priya api outage\"."),
      count: z.number().int().min(1).max(100).default(20).describe("Hits per page (default 20)."),
      page: z.number().int().min(1).default(1).describe("Page number (default 1)."),
    }),
  },
  async ({ query, count, page }) => {
    try {
      const { total, hits } = await searchMessages(getCreds(), query, count, page);
      if (hits.length === 0) {
        return textResult(`0 hits for "${query}".`);
      }
      const parts: string[] = [];
      for (const hit of hits) {
        parts.push(await formatSearchHit(getCreds(), hit));
      }
      const more =
        total > hits.length * page
          ? `\n\n[showing page ${page} — call again with page ${page + 1} for more]`
          : "";
      return textResult(`${total} hit(s) for "${query}":\n\n${parts.join("\n\n---\n\n")}${more}`);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "sync_directory",
  {
    description:
      "Rebuild the local conversation + user directory cache (directory.json). Quick mode (default) pulls conversations and resolves DM peers one by one — gentle on rate limits. Full mode additionally pulls the entire user list (slow, Tier-2 limited). The cache also grows on its own: every lookup persists what it used. Run quick after login and when channels change.",
    inputSchema: z.object({
      mode: z
        .enum(["quick", "full"])
        .default("quick")
        .describe("\"quick\" for conversations + DM peers, \"full\" to also pull every user."),
    }),
  },
  async ({ mode }) => {
    try {
      const summary = await syncDirectory(getCreds(), mode);
      return textResult(
        `Synced [${summary.mode}] ${summary.team} -> ${summary.path}:\n` +
          `- conversations: ${summary.conversations} (DMs: ${summary.dms}, group DMs: ${summary.groups})\n` +
          `- users: ${summary.users}` +
          ` | custom emoji: ${summary.custom_emoji}` +
          (summary.truncated ? "\n- WARNING: hit API page caps, results truncated" : "") +
          `\nAsk for a person (e.g. "message Vageesh") and the channel resolves from this file.`,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

serveStdio(() => server);

debugLog("stdio server started");
