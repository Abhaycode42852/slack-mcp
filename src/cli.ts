/**
 * Tiny CLI for smoke-testing the Slack session without an MCP client.
 * Sends/edits/reactions/uploads STAGE a preview (nothing goes out);
 * run `confirm <id>` to execute, `cancel <id>` to drop.
 *
 *   npm run cli -- whoami
 *   npm run cli -- list [query]
 *   npm run cli -- read <channel|me|#name|@user> [limit]
 *   npm run cli -- thread <channel> <thread_ts>
 *   npm run cli -- send <channel|me> <text...>
 *   npm run cli -- edit <channel> <ts> <text...>
 *   npm run cli -- react <channel> <ts> <emoji>
 *   npm run cli -- unreact <channel> <ts> <emoji>
 *   npm run cli -- upload <channel|me> <path> [comment...]
 *   npm run cli -- confirm <action_id>
 *   npm run cli -- cancel <action_id>
 *   npm run cli -- pending
 *   npm run cli -- search <query...>
 *   npm run cli -- sync [quick|full]  (rebuild directory.json cache)
 *   npm run cli -- lookup <name>   (resolve a person/channel from the cache)
 *   npm run cli -- emoji <name>    (check the local emoji catalog)
 */
import { audit, loadCredentials, type SlackCredentials } from "./credentials.js";
import { lookupEmoji, normalizeEmojiName } from "./emoji.js";
import { loadEnvFile } from "./load-env.js";
import {
  cancelPending,
  formatPreview,
  listPending,
  restagePending,
  stagePending,
  takePending,
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
} from "./slack.js";

loadEnvFile();

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let creds: SlackCredentials;
  try {
    creds = loadCredentials();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  try {
    switch (command) {
      case "whoami": {
        const info = await authTest(creds);
        console.log(JSON.stringify(info, null, 2));
        break;
      }
      case "list": {
        const query = rest[0]?.toLowerCase();
        const all = await listConversations(creds);
        const items = query
          ? all.filter((c) => c.label.toLowerCase().includes(query) || c.id === rest[0])
          : all;
        for (const c of items.slice(0, 100)) {
          console.log(
            `${c.label} (${c.id})${c.num_members ? ` · ${c.num_members} members` : ""}${c.is_archived ? " · archived" : ""}`,
          );
        }
        console.log(`\n${items.length} conversation(s)`);
        break;
      }
      case "read": {
        const target = rest[0];
        if (!target) throw new Error("usage: read <channel|me|#name|@user> [limit]");
        const { id, label } = await resolveChannel(creds, target);
        const limit = Math.min(Number(rest[1] ?? 20) || 20, 200);
        const page = await readHistory(creds, id, { limit });
        console.log(`# ${label} (${id})`);
        console.log(await formatMessages(creds, page.messages, { reverse: true }));
        if (page.has_more) console.log(`\n[more available, cursor: ${page.next_cursor}]`);
        break;
      }
      case "thread": {
        const [target, threadTs] = rest;
        if (!target || !threadTs) throw new Error("usage: thread <channel> <thread_ts>");
        const { id, label } = await resolveChannel(creds, target);
        const page = await readThread(creds, id, threadTs, {});
        console.log(`# ${label} thread ${threadTs}`);
        console.log(await formatMessages(creds, page.messages));
        break;
      }
      case "send": {
        const [target, ...words] = rest;
        if (!target || words.length === 0) throw new Error("usage: send <channel|me> <text...>");
        const { id, label, kind } = await resolveChannel(creds, target);
        const staged = stagePending({
          action: "send",
          channel_id: id,
          channel_label: label,
          kind,
          text: words.join(" "),
        });
        audit("stage_send", { action_id: staged.id, channel: id });
        console.log(`STAGED — nothing sent yet.\n\n${formatPreview(staged)}`);
        break;
      }
      case "edit": {
        const [target, ts, ...words] = rest;
        if (!target || !ts || words.length === 0) {
          throw new Error("usage: edit <channel> <ts> <text...>");
        }
        const { id, label, kind } = await resolveChannel(creds, target);
        const staged = stagePending({
          action: "edit",
          channel_id: id,
          channel_label: label,
          kind,
          text: words.join(" "),
          ts,
        });
        audit("stage_edit", { action_id: staged.id, channel: id, ts });
        console.log(`STAGED — nothing changed yet.\n\n${formatPreview(staged)}`);
        break;
      }
      case "react":
      case "unreact": {
        const [target, ts, emoji] = rest;
        if (!target || !ts || !emoji) {
          throw new Error(`usage: ${command} <channel> <ts> <emoji>`);
        }
        const { id, label, kind } = await resolveChannel(creds, target);
        const name = normalizeEmojiName(emoji);
        const staged = stagePending({
          action: command === "react" ? "reaction" : "unreact",
          channel_id: id,
          channel_label: label,
          kind,
          ts,
          emoji: name,
          emoji_char: lookupEmoji(name)?.char,
        });
        audit(`stage_${command}`, { action_id: staged.id, channel: id, ts, emoji: name });
        console.log(`STAGED — nothing ${command === "react" ? "added" : "removed"} yet.\n\n${formatPreview(staged)}`);
        break;
      }
      case "upload": {
        const [target, path, ...words] = rest;
        if (!target || !path) throw new Error("usage: upload <channel|me> <path> [comment...]");
        const { id, label, kind } = await resolveChannel(creds, target);
        const info = inspectUploadFile(path);
        const staged = stagePending({
          action: "upload",
          channel_id: id,
          channel_label: label,
          kind,
          text: words.length > 0 ? words.join(" ") : undefined,
          file_path: info.path,
          file_name: info.name,
          file_bytes: info.bytes,
        });
        audit("stage_upload", { action_id: staged.id, channel: id, path, bytes: info.bytes });
        console.log(`STAGED — nothing uploaded yet.\n\n${formatPreview(staged)}`);
        break;
      }
      case "confirm": {
        const [actionId] = rest;
        if (!actionId) throw new Error("usage: confirm <action_id>");
        const entry = takePending(actionId.trim());
        if (!entry) throw new Error(`No pending action "${actionId}" (unknown, done, or expired after 5 min).`);
        try {
          switch (entry.action) {
            case "send": {
              const result = await sendMessage(creds, entry.channel_id, entry.text ?? "", {
                thread_ts: entry.thread_ts,
              });
              audit("send_message", { action_id: entry.id, channel: result.channel, ts: result.ts });
              console.log(`sent: channel=${result.channel} ts=${result.ts}`);
              break;
            }
            case "edit": {
              const result = await editMessage(creds, entry.channel_id, entry.ts ?? "", entry.text ?? "");
              audit("edit_message", { action_id: entry.id, channel: result.channel, ts: result.ts });
              console.log(`edited: channel=${result.channel} ts=${result.ts}`);
              break;
            }
            case "reaction": {
              await addReaction(creds, entry.channel_id, entry.ts ?? "", entry.emoji ?? "");
              audit("add_reaction", { action_id: entry.id, channel: entry.channel_id, ts: entry.ts });
              console.log(`added :${entry.emoji}: to ${entry.ts}`);
              break;
            }
            case "unreact": {
              await removeReaction(creds, entry.channel_id, entry.ts ?? "", entry.emoji ?? "");
              audit("remove_reaction", { action_id: entry.id, channel: entry.channel_id, ts: entry.ts });
              console.log(`removed :${entry.emoji}: from ${entry.ts}`);
              break;
            }
            case "upload": {
              const result = await uploadFile(creds, entry.channel_id, entry.file_path ?? "", {
                filename: entry.file_name,
                title: entry.file_title,
                initialComment: entry.text,
                threadTs: entry.thread_ts,
              });
              audit("upload_file", { action_id: entry.id, channel: result.channel, file_id: result.file_id });
              console.log(`uploaded: channel=${result.channel} ts=${result.ts} file_id=${result.file_id}`);
              break;
            }
          }
        } catch (error) {
          const { id: _id, created_at: _c, expires_at: _e, ...retryRest } = entry;
          void _id;
          void _c;
          void _e;
          const retry = restagePending(retryRest);
          console.error("confirm failed; re-staged as", retry.id);
          throw error;
        }
        break;
      }
      case "cancel": {
        const [actionId] = rest;
        if (!actionId) throw new Error("usage: cancel <action_id>");
        const entry = cancelPending(actionId.trim());
        if (!entry) throw new Error(`No pending action "${actionId}". Nothing to cancel.`);
        audit("cancel", { action_id: entry.id, action: entry.action });
        console.log(`cancelled ${entry.action} ${entry.id}. Nothing was sent.`);
        break;
      }
      case "pending": {
        const pending = listPending();
        if (pending.length === 0) {
          console.log("Nothing is currently pending.");
        } else {
          console.log(pending.map((p) => formatPreview(p)).join("\n\n---\n\n"));
        }
        break;
      }
      case "search": {
        const query = rest.join(" ");
        if (!query) throw new Error("usage: search <query...>");
        const { total, hits } = await searchMessages(creds, query, 20, 1);
        console.log(`${total} hit(s)`);
        for (const hit of hits) {
          console.log("\n" + (await formatSearchHit(creds, hit)));
        }
        break;
      }
      case "sync": {
        const mode = rest[0] === "full" ? "full" : "quick";
        const summary = await syncDirectory(creds, mode);
        console.log(`team: ${summary.team} (${summary.team_id}) [${summary.mode}]`);
        console.log(
          `conversations: ${summary.conversations} (DMs: ${summary.dms}, group DMs: ${summary.groups})`,
        );
        console.log(
          `users: ${summary.users}${summary.truncated ? " (TRUNCATED by API page caps)" : ""}`,
        );
        console.log(`custom emoji: ${summary.custom_emoji}`);
        console.log(`wrote: ${summary.path}`);
        break;
      }
      case "lookup": {
        const name = rest.join(" ");
        if (!name) throw new Error("usage: lookup <person or channel name>");
        const resolved = await resolveChannel(creds, name);
        console.log(`${resolved.label}\n  id:   ${resolved.id}\n  kind: ${resolved.kind}`);
        const dir = readDirectory();
        if (dir) {
          console.log(`  (cache: ${dir.conversations.length} convs, synced ${dir.synced_at})`);
        } else {
          console.log("  (no directory cache — run sync first)");
        }
        break;
      }
      case "emoji": {
        const name = rest.join(" ");
        if (!name) throw new Error("usage: emoji <name>");
        const { lookupEmoji, suggestEmoji } = await import("./emoji.js");
        const hit = lookupEmoji(name);
        if (hit) {
          console.log(
            `:${hit.name}:  status=${hit.slack}${hit.custom ? " (workspace custom)" : ""}`,
          );
        } else {
          const suggestions = suggestEmoji(name);
          console.log(
            `not in local catalog` +
              (suggestions.length ? ` — did you mean: ${suggestions.map((s) => `:${s}:`).join(" ")}?` : ""),
          );
        }
        break;
      }
      default:
        console.log(
          "commands: whoami | list [query] | read <channel> [limit] | thread <channel> <ts> | send <channel> <text...> | edit <channel> <ts> <text...> | react|unreact <channel> <ts> <emoji> | upload <channel> <path> [comment...] | confirm <id> | cancel <id> | pending | search <query...> | sync [quick|full] | lookup <name> | emoji <name>",
        );
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof SlackError) {
      console.error(friendlyErrorHint(error));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  }
}

main();
