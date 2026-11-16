/**
 * Thin Slack Web API client that authenticates with the browser session pair:
 * an xoxc token (form field or bearer) plus the `d` cookie (xoxd).
 * This is the same pair Slack's own web client sends, so every call acts
 * as the signed-in user with their exact permissions.
 */
import { randomUUID } from "crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { configDir, type SlackCredentials } from "./credentials.js";
import {
  lookupEmoji,
  markEmojiInvalid,
  markEmojiOk,
  mergeCustomEmoji,
  normalizeEmojiName,
  suggestEmoji,
} from "./emoji.js";

const API_BASE = "https://slack.com/api/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

const RETRYABLE_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

export class SlackError extends Error {
  code: string;
  method: string;

  constructor(method: string, code: string, detail = "") {
    super(detail ? `Slack ${method} failed: ${code} (${detail})` : `Slack ${method} failed: ${code}`);
    this.method = method;
    this.code = code;
  }
}

export function isAuthError(code: string): boolean {
  return AUTH_ERRORS.has(code);
}

export function friendlyErrorHint(error: SlackError): string {
  if (isAuthError(error.code)) {
    return (
      `Authentication rejected by Slack (${error.code}). The browser session ` +
      `behind the token/cookie pair has expired or been revoked. Re-run ` +
      `\`npm run login\` in the slack-mcp folder and paste fresh values.`
    );
  }
  switch (error.code) {
    case "channel_not_found":
      return "Unknown channel. Use list_conversations to find the right id or name.";
    case "cant_update_message":
      return "Only messages you sent yourself can be edited.";
    case "cant_delete_message":
      return "Only messages you sent yourself can be deleted.";
    case "msg_too_long":
      return "Message exceeds Slack's ~4000 character limit. Split it into parts.";
    case "already_reacted":
      return "That reaction is already on the message.";
    case "no_reaction":
      return "That reaction is not on the message, so there is nothing to remove.";
    case "thread_not_found":
      return "No thread starts at that timestamp. Read the channel first to get a valid thread_ts.";
    case "message_not_found":
      return "No message at that timestamp. Read the channel first to get a valid ts.";
    case "not_in_channel":
      return "You are not a member of that channel. Join it in Slack first.";
    case "search_not_available":
      return "Search is not available for this workspace/token. Ask the workspace admin about search access.";
    default:
      return error.message;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- low-level call ---------------------------------------------------------

// Small gap between calls so paged reads stay well under Slack's per-minute
// limits. Tier-2 methods allow ~20+/min sustained and dislike bursts, so
// calls are serialized through a promise-chain lock with a 1.2s gap.
let lastCallAt = 0;
let paceChain: Promise<void> = Promise.resolve();

function pace(): Promise<void> {
  const run = paceChain.then(async () => {
    const gap = 1200;
    const wait = gap - (Date.now() - lastCallAt);
    if (wait > 0) {
      await sleep(wait);
    }
    lastCallAt = Date.now();
  });
  paceChain = run.catch(() => {});
  return run;
}

const MAX_RETRIES = 5;

function retryAfterMs(headers: Headers, attempt: number): number {
  const raw = headers.get("retry-after");
  const seconds = raw ? Number(raw) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  return Math.min(2000 * 2 ** attempt, 30000) + Math.random() * 500;
}

async function rawCall(
  creds: SlackCredentials,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
  attempt = 0,
): Promise<Record<string, unknown>> {
  await pace();

  const body = new URLSearchParams();
  body.set("token", creds.xoxc);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    body.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        Cookie: `${creds.cookie_name}=${creds.xoxd}`,
      },
      body,
    });
  } catch (error) {
    throw new SlackError(method, "network_error", String(error));
  }

  if (response.status === 429) {
    if (attempt >= MAX_RETRIES) throw new SlackError(method, "ratelimited", "gave up after retries");
    await sleep(retryAfterMs(response.headers, attempt));
    return rawCall(creds, method, params, attempt + 1);
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new SlackError(method, `http_${response.status}`, "Slack returned a non-JSON response");
  }

  if (payload.ok === true) {
    return payload;
  }

  const code = typeof payload.error === "string" ? payload.error : "unknown_error";
  if (RETRYABLE_ERRORS.has(code)) {
    if (attempt >= MAX_RETRIES) throw new SlackError(method, code, "gave up after retries");
    await sleep(retryAfterMs(response.headers, attempt));
    return rawCall(creds, method, params, attempt + 1);
  }

  const detail =
    typeof payload.detail === "string"
      ? payload.detail
      : typeof payload.response_metadata === "object" &&
          payload.response_metadata !== null &&
          Array.isArray((payload.response_metadata as Record<string, unknown>).messages)
        ? ((payload.response_metadata as Record<string, unknown>).messages as string[]).join("; ")
        : "";
  throw new SlackError(method, code, detail);
}

// --- typed wrappers ---------------------------------------------------------

export interface AuthInfo {
  team: string;
  team_id: string;
  user: string;
  user_id: string;
  url: string;
}

export async function authTest(creds: SlackCredentials): Promise<AuthInfo> {
  const payload = await rawCall(creds, "auth.test", {});
  return {
    team: String(payload.team ?? ""),
    team_id: String(payload.team_id ?? creds.team_id),
    user: String(payload.user ?? ""),
    user_id: String(payload.user_id ?? ""),
    url: String(payload.url ?? ""),
  };
}

export interface ChannelInfo {
  id: string;
  name: string;
  is_private: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_archived: boolean;
  user: string;
  num_members: number;
}

interface UserInfo {
  id: string;
  name: string;
  real_name: string;
  display_name: string;
  email: string;
  deleted: boolean;
  is_bot: boolean;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  edited?: { ts?: string; user?: string };
  reactions?: Array<{ name?: string; count?: number }>;
  files?: Array<{ id?: string; name?: string; title?: string }>;
  permalink?: string;
}

export interface HistoryPage {
  messages: SlackMessage[];
  has_more: boolean;
  next_cursor: string;
}

export interface SearchHit {
  ts: string;
  user?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  permalink?: string;
  channel_id?: string;
  channel_name?: string;
}

// Conversation + user caches, so name resolution costs nothing after warmup.
let convCache: { at: number; items: ChannelInfo[] } | null = null;
let userCache: { at: number; items: UserInfo[] } | null = null;
const nameCache = new Map<string, string>();
let selfDmId: string | null = null;

const CONV_TTL_MS = 5 * 60 * 1000;
const USER_TTL_MS = 30 * 60 * 1000;

export function clearCaches(): void {
  convCache = null;
  userCache = null;
  nameCache.clear();
  selfDmId = null;
}

async function listMyConversations(creds: SlackCredentials, force = false): Promise<ChannelInfo[]> {
  if (!force && convCache && Date.now() - convCache.at < CONV_TTL_MS) {
    return convCache.items;
  }
  const collected: ChannelInfo[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const payload = await rawCall(creds, "users.conversations", {
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: false,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const channels = (payload.channels ?? []) as ChannelInfo[];
    collected.push(...channels);
    const next = (payload.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
    if (!next) break;
    cursor = next;
  }
  convCache = { at: Date.now(), items: collected };
  return collected;
}

async function listUsers(creds: SlackCredentials, force = false): Promise<UserInfo[]> {
  if (!force && userCache && Date.now() - userCache.at < USER_TTL_MS) {
    return userCache.items;
  }
  const collected: UserInfo[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const payload = await rawCall(creds, "users.list", {
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const members = ((payload.members ?? []) as Array<Record<string, unknown>>).map((m) => {
      const profile = (m.profile ?? {}) as Record<string, unknown>;
      return {
        id: String(m.id ?? ""),
        name: String(m.name ?? ""),
        real_name: String(m.real_name ?? ""),
        display_name: String(profile.display_name ?? ""),
        email: String(profile.email ?? ""),
        deleted: m.deleted === true,
        is_bot: m.is_bot === true,
      } as UserInfo;
    });
    collected.push(...members);
    const next = (payload.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
    if (!next) break;
    cursor = next;
  }
  userCache = { at: Date.now(), items: collected };
  return collected;
}

async function displayName(creds: SlackCredentials, userId: string): Promise<string> {
  if (!userId) return "unknown";
  const cached = nameCache.get(userId);
  if (cached) return cached;

  // On-demand path first: directory file, then a single users.info call.
  // Bulk users.list is reserved for full syncs and last-resort lookups.
  const dir = readDirectory();
  const known = dir?.users.find((u) => u.id === userId);
  if (known) {
    const name = known.display_name || known.real_name || known.name || userId;
    nameCache.set(userId, name);
    return name;
  }

  try {
    const payload = await rawCall(creds, "users.info", { user: userId });
    const user = (payload.user ?? {}) as {
      name?: string;
      real_name?: string;
      profile?: { display_name?: string; email?: string };
    };
    const name =
      user.profile?.display_name || user.real_name || user.name || userId;
    nameCache.set(userId, name);
    upsertDirectoryUser(creds, {
      id: userId,
      name: user.name ?? "",
      display_name: user.profile?.display_name ?? "",
      real_name: user.real_name ?? "",
      email: user.profile?.email ?? "",
    });
    return name;
  } catch {
    return userId;
  }
}

async function userIdByName(creds: SlackCredentials, name: string): Promise<UserInfo | null> {
  const lowered = name.toLowerCase();
  const users = await listUsers(creds);
  return (
    users.find(
      (u) =>
        !u.deleted &&
        (u.name.toLowerCase() === lowered ||
          u.display_name.toLowerCase() === lowered ||
          u.real_name.toLowerCase() === lowered),
    ) ?? null
  );
}

async function openSelfDm(creds: SlackCredentials): Promise<string> {
  if (selfDmId) return selfDmId;
  let userId = creds.user_id;
  if (!userId) {
    const info = await authTest(creds);
    userId = info.user_id;
  }
  if (!userId) {
    throw new SlackError("conversations.open", "no_user", "Could not determine your user id");
  }
  const payload = await rawCall(creds, "conversations.open", { users: userId });
  const id = (payload.channel as { id?: string } | undefined)?.id ?? "";
  if (!id) {
    throw new SlackError("conversations.open", "no_channel", "Slack returned no self-DM channel");
  }
  selfDmId = id;
  return id;
}

const ID_PATTERN = /^[CGD][A-Z0-9]{6,}$/;

export type KnownChannelKind = "channel" | "private" | "im" | "mpim";
export type ChannelKind = KnownChannelKind | "unknown";

export interface ResolvedChannel {
  id: string;
  label: string;
  kind: ChannelKind;
}

function channelKind(c: {
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
}): KnownChannelKind {
  if (c.is_mpim) return "mpim";
  if (c.is_im) return "im";
  if (c.is_private) return "private";
  return "channel";
}

/** Kind of a raw channel id: memory -> directory file -> live conversations.info. */
export async function kindForId(creds: SlackCredentials, id: string): Promise<ChannelKind> {
  if (convCache) {
    const hit = convCache.items.find((c) => c.id === id);
    if (hit) return channelKind(hit);
  }
  const dir = readDirectory();
  const dhit = dir?.conversations.find((c) => c.id === id);
  if (dhit) return dhit.kind;
  if (/^[CGD]/.test(id)) {
    try {
      const payload = await rawCall(creds, "conversations.info", { channel: id });
      const ch = (payload.channel ?? {}) as {
        is_im?: boolean;
        is_mpim?: boolean;
        is_private?: boolean;
      };
      return channelKind({
        is_im: ch.is_im === true,
        is_mpim: ch.is_mpim === true,
        is_private: ch.is_private === true,
      });
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

/**
 * Accepts a raw channel id, `#name`, plain channel name, `@user` / display
 * name / email, a DM id, or `me` for your own DM — and returns the
 * conversation id plus its kind. Consults the on-disk directory cache first
 * (see syncDirectory), falling back to live API calls.
 */
export async function resolveChannel(
  creds: SlackCredentials,
  input: string,
): Promise<ResolvedChannel> {
  const raw = input.trim();
  const bare = raw.startsWith("#") ? raw.slice(1) : raw;

  if (ID_PATTERN.test(bare)) {
    return { id: bare, label: raw, kind: await kindForId(creds, bare) };
  }

  const lowered = bare.toLowerCase();
  if (lowered === "me" || lowered === "@me" || lowered === "self" || lowered === "dm:self") {
    const id = await openSelfDm(creds);
    return { id, label: "me (your DM)", kind: "im" };
  }

  const personName = lowered.replace(/^(dm:|@)/, "");

  // Fast path: on-disk directory written by syncDirectory.
  const dir = readDirectory();
  if (dir) {
    const norm = (v: unknown): string => (typeof v === "string" ? v : "");
    const byName = dir.conversations.find(
      (c) =>
        !c.is_archived &&
        (c.id === bare ||
          norm(c.label).toLowerCase() === lowered ||
          norm(c.name).toLowerCase() === lowered ||
          `#${norm(c.name)}`.toLowerCase() === lowered),
    );
    if (byName) {
      return { id: byName.id, label: byName.label, kind: byName.kind };
    }
    const person = dir.users.find(
      (u) =>
        !u.deleted &&
        (norm(u.name).toLowerCase() === personName ||
          norm(u.display_name).toLowerCase() === personName ||
          norm(u.real_name).toLowerCase() === personName ||
          (norm(u.email) !== "" && norm(u.email).toLowerCase() === personName)),
    );
    if (person) {
      const dm = dir.conversations.find((c) => c.kind === "im" && c.user === person.id);
      if (dm) {
        return { id: dm.id, label: dm.label, kind: "im" };
      }
      // Known person but no cached DM: fall through to live conversations.open.
    }
    // Anything else falls through to the live path below (cache may be stale).
  }

  const conversations = await listMyConversations(creds);

  const exact = conversations.filter(
    (c) => c.name && c.name.toLowerCase() === lowered && !c.is_archived,
  );
  if (exact.length === 1) {
    const c = exact[0];
    upsertDirectoryConversation(creds, c, channelLabel(c));
    return { id: c.id, label: channelLabel(c), kind: channelKind(c) };
  }
  if (exact.length > 1) {
    const options = exact.map((c) => `${channelLabel(c)} (${c.id})`).join(", ");
    throw new SlackError("resolveChannel", "ambiguous_channel", `"${raw}" matches several conversations: ${options}`);
  }

  // Person reference -> open (or reuse) a DM with them.
  const person = await userIdByName(creds, personName);
  if (person) {
    upsertDirectoryUser(creds, {
      id: person.id,
      name: person.name,
      display_name: person.display_name,
      real_name: person.real_name,
      email: person.email,
    });
    const existing = conversations.find((c) => c.is_im && c.user === person.id);
    if (existing) {
      const label = `dm:${await displayName(creds, person.id)}`;
      upsertDirectoryConversation(creds, existing, label);
      return { id: existing.id, label, kind: "im" };
    }
    const payload = await rawCall(creds, "conversations.open", { users: person.id });
    const id = (payload.channel as { id?: string } | undefined)?.id ?? "";
    if (!id) throw new SlackError("conversations.open", "no_channel", "Slack returned no DM channel");
    convCache = null; // new channel exists now
    const label = `dm:${await displayName(creds, person.id)}`;
    upsertDirectoryConversation(
      creds,
      { id, name: "", is_private: false, is_im: true, is_mpim: false, is_archived: false, user: person.id, num_members: 2 },
      label,
    );
    return { id, label, kind: "im" };
  }

  const similar = conversations
    .filter((c) => c.name && c.name.toLowerCase().includes(lowered))
    .slice(0, 8)
    .map((c) => `${channelLabel(c)} (${c.id})`);
  const hint = similar.length ? ` Similar: ${similar.join(", ")}.` : "";
  const staleNote = dir ? " (not in the directory cache — run sync_directory to refresh it)" : "";
  throw new SlackError("resolveChannel", "channel_not_found", `No conversation named "${raw}".${hint}${staleNote}`);
}

function channelLabel(c: ChannelInfo): string {
  if (c.is_im) return `dm:${c.user}`;
  if (c.is_mpim) return `group:${c.name || c.id}`;
  return `${c.is_private ? "private:" : "#"}${c.name || c.id}`;
}

export async function relabelDmChannels(
  creds: SlackCredentials,
  channels: ChannelInfo[],
): Promise<Array<ChannelInfo & { label: string }>> {
  // Sequential on purpose: displayName warms the shared users cache on the
  // first DM, and parallel calls would stampede the API before it is warm.
  const out: Array<ChannelInfo & { label: string }> = [];
  for (const c of channels) {
    if (c.is_im && c.user) {
      out.push({ ...c, label: `dm:${await displayName(creds, c.user)}` });
    } else {
      out.push({ ...c, label: channelLabel(c) });
    }
  }
  return out;
}

/** Every conversation you belong to, with a human-readable label. */
export async function listConversations(
  creds: SlackCredentials,
): Promise<Array<ChannelInfo & { label: string }>> {
  return relabelDmChannels(creds, await listMyConversations(creds));
}

// --- on-disk directory cache -----------------------------------------------

export interface DirectoryConversation {
  id: string;
  label: string;
  name: string;
  kind: KnownChannelKind;
  user: string;
  num_members: number;
  is_archived: boolean;
}

export interface DirectoryUser {
  id: string;
  name: string;
  display_name: string;
  real_name: string;
  email: string;
  deleted: boolean;
}

export interface Directory {
  team_id: string;
  team: string;
  synced_at: string;
  truncated: boolean;
  conversations: DirectoryConversation[];
  users: DirectoryUser[];
}

export function directoryPath(): string {
  return join(configDir(), "directory.json");
}

/** The cached directory, or null when `sync` has never run. */
export function readDirectory(): Directory | null {
  try {
    if (!existsSync(directoryPath())) return null;
    const parsed = JSON.parse(readFileSync(directoryPath(), "utf8")) as Directory;
    if (!Array.isArray(parsed.conversations) || !Array.isArray(parsed.users)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function emptyDirectory(teamId = "", team = ""): Directory {
  return {
    team_id: teamId,
    team,
    synced_at: new Date().toISOString(),
    truncated: false,
    conversations: [],
    users: [],
  };
}

function saveDirectory(dir: Directory): void {
  dir.synced_at = new Date().toISOString();
  const path = directoryPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(dir, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Merge one conversation into the on-disk cache (creates the file if needed). */
export function upsertDirectoryConversation(
  creds: SlackCredentials,
  c: ChannelInfo,
  label?: string,
): void {
  try {
    const dir = readDirectory() ?? emptyDirectory(creds.team_id, "");
    const entry: DirectoryConversation = {
      id: c.id,
      label: label ?? c.name ?? c.id,
      name: c.name ?? "",
      kind: channelKind(c),
      user: c.user ?? "",
      num_members: c.num_members ?? 0,
      is_archived: c.is_archived === true,
    };
    const i = dir.conversations.findIndex((e) => e.id === entry.id);
    if (i >= 0) {
      dir.conversations[i] = { ...dir.conversations[i], ...entry };
    } else {
      dir.conversations.push(entry);
    }
    saveDirectory(dir);
  } catch {
    // Cache writes must never break a call.
  }
}

/** Merge one user into the on-disk cache (creates the file if needed). */
export function upsertDirectoryUser(
  creds: SlackCredentials,
  u: { id: string; name: string; display_name: string; real_name: string; email?: string },
): void {
  try {
    const dir = readDirectory() ?? emptyDirectory(creds.team_id, "");
    const entry: DirectoryUser = {
      id: u.id,
      name: u.name ?? "",
      display_name: u.display_name ?? "",
      real_name: u.real_name ?? "",
      email: u.email ?? "",
      deleted: false,
    };
    const i = dir.users.findIndex((e) => e.id === entry.id);
    if (i >= 0) {
      dir.users[i] = { ...dir.users[i], ...entry };
    } else {
      dir.users.push(entry);
    }
    saveDirectory(dir);
  } catch {
    // Cache writes must never break a call.
  }
}

export interface DirectorySummary {
  path: string;
  team: string;
  team_id: string;
  mode: string;
  conversations: number;
  dms: number;
  groups: number;
  users: number;
  custom_emoji: number;
  truncated: boolean;
}

/**
 * Rebuild the directory cache file.
 *
 * - "quick" (default): conversations via users.conversations + one users.info
 *   per DM peer (Tier-4, generous limits). No bulk users.list.
 * - "full": additionally pulls the whole users.list (Tier-2, paged, slow).
 *   Only needed when you must resolve a name you have never touched before
 *   and the on-demand path is not enough.
 *
 * Day to day the file grows on its own: every lookup persists what it used.
 */
export async function syncDirectory(
  creds: SlackCredentials,
  mode: "quick" | "full" = "quick",
): Promise<DirectorySummary> {
  const info = await authTest(creds);
  const conversations = await listMyConversations(creds, true);
  const labeled = await relabelDmChannels(creds, conversations);

  // Re-read: DM labeling above already persisted every peer user on demand.
  const dir = readDirectory() ?? emptyDirectory(info.team_id, info.team);
  dir.team_id = info.team_id;
  dir.team = info.team;
  dir.truncated = conversations.length >= 2000;
  dir.conversations = labeled.map((c) => ({
    id: c.id,
    label: c.label,
    name: c.name ?? "",
    kind: channelKind(c),
    user: c.user ?? "",
    num_members: c.num_members ?? 0,
    is_archived: c.is_archived === true,
  }));

  if (mode === "full") {
    const users = await listUsers(creds, true);
    dir.truncated = dir.truncated || users.length >= 4000;
    const byId = new Map(dir.users.map((u) => [u.id, u]));
    for (const u of users) {
      byId.set(u.id, {
        id: u.id,
        name: u.name ?? "",
        display_name: u.display_name ?? "",
        real_name: u.real_name ?? "",
        email: u.email ?? "",
        deleted: u.deleted === true,
      });
    }
    dir.users = [...byId.values()];
  }

  saveDirectory(dir);

  // Workspace custom emoji: one cheap call, merged into emoji.json.
  let customEmoji = 0;
  try {
    const emojiPayload = await rawCall(creds, "emoji.list", {});
    const custom = (emojiPayload.emoji ?? {}) as Record<string, string>;
    if (custom && typeof custom === "object") {
      mergeCustomEmoji(custom);
      customEmoji = Object.keys(custom).length;
    }
  } catch {
    // Custom emoji merge is best-effort (may be restricted on some workspaces).
  }

  const path = directoryPath();
  const dms = dir.conversations.filter((c) => c.kind === "im").length;
  const groups = dir.conversations.filter((c) => c.kind === "mpim").length;
  return {
    path,
    team: info.team,
    team_id: info.team_id,
    mode,
    conversations: dir.conversations.length,
    dms,
    groups,
    users: dir.users.length,
    custom_emoji: customEmoji,
    truncated: dir.truncated,
  };
}

// --- message operations -----------------------------------------------------

export async function readHistory(
  creds: SlackCredentials,
  channel: string,
  options: { limit?: number; oldest?: string; latest?: string; cursor?: string } = {},
): Promise<HistoryPage> {
  const payload = await rawCall(creds, "conversations.history", {
    channel,
    limit: options.limit ?? 20,
    oldest: options.oldest,
    latest: options.latest,
    cursor: options.cursor,
  });
  return {
    messages: ((payload.messages ?? []) as SlackMessage[]).map(normalizeMessage),
    has_more: payload.has_more === true,
    next_cursor:
      (payload.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "",
  };
}

export async function readThread(
  creds: SlackCredentials,
  channel: string,
  threadTs: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<HistoryPage> {
  const payload = await rawCall(creds, "conversations.replies", {
    channel,
    ts: threadTs,
    limit: options.limit ?? 100,
    cursor: options.cursor,
  });
  return {
    messages: ((payload.messages ?? []) as SlackMessage[]).map(normalizeMessage),
    has_more: payload.has_more === true,
    next_cursor:
      (payload.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "",
  };
}

function normalizeMessage(m: SlackMessage): SlackMessage {
  return { ...m, text: m.text ?? "" };
}

export async function sendMessage(
  creds: SlackCredentials,
  channel: string,
  text: string,
  options: {
    thread_ts?: string;
    unfurl_links?: boolean;
    unfurl_media?: boolean;
    blocks?: unknown[];
  } = {},
): Promise<{ channel: string; ts: string }> {
  const payload = await rawCall(creds, "chat.postMessage", {
    channel,
    text,
    thread_ts: options.thread_ts,
    unfurl_links: options.unfurl_links === true,
    unfurl_media: options.unfurl_media === true,
    blocks: options.blocks ? JSON.stringify(options.blocks) : undefined,
    // Dedupe key: a retried request with the same key cannot double-post.
    client_msg_id: randomUUID(),
  });
  return { channel: String(payload.channel ?? channel), ts: String(payload.ts ?? "") };
}

export async function editMessage(
  creds: SlackCredentials,
  channel: string,
  ts: string,
  text: string,
  options: { blocks?: unknown[] } = {},
): Promise<{ channel: string; ts: string }> {
  const payload = await rawCall(creds, "chat.update", {
    channel,
    ts,
    text,
    blocks: options.blocks ? JSON.stringify(options.blocks) : undefined,
  });
  return { channel: String(payload.channel ?? channel), ts: String(payload.ts ?? ts) };
}

/**
 * File upload via Slack's 3-step external flow (files.upload v1 is retired):
 *  1. files.getUploadURLExternal -> signed upload_url + file_id
 *  2. POST the bytes to upload_url (hosted, pre-signed, no auth needed)
 *  3. files.completeUploadExternal -> shares the file into the channel
 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface UploadFileInfo {
  path: string;
  name: string;
  bytes: number;
  mtime: string;
}

/** Validate the file at stage time (bytes are read again at confirm time). */
export function inspectUploadFile(path: string, filename?: string): UploadFileInfo {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new SlackError("upload", "file_not_found", `No file at ${path}.`);
  }
  if (!stat.isFile()) {
    throw new SlackError("upload", "not_a_file", `${path} is not a regular file.`);
  }
  if (stat.size === 0) {
    throw new SlackError("upload", "empty_file", `${path} is empty.`);
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new SlackError(
      "upload",
      "file_too_large",
      `${path} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; refusing above ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }
  return {
    path,
    name: filename?.trim() || basename(path),
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

export async function uploadFile(
  creds: SlackCredentials,
  channel: string,
  path: string,
  options: {
    filename?: string;
    title?: string;
    initialComment?: string;
    threadTs?: string;
  } = {},
): Promise<{ channel: string; ts: string; file_id: string }> {
  const info = inspectUploadFile(path, options.filename);

  const urlPayload = await rawCall(creds, "files.getUploadURLExternal", {
    filename: info.name,
    length: info.bytes,
  });
  const uploadUrl = String(urlPayload.upload_url ?? "");
  const fileId = String(urlPayload.file_id ?? "");
  if (!uploadUrl || !fileId) {
    throw new SlackError("files.getUploadURLExternal", "no_upload_url", "Slack did not return an upload URL.");
  }

  const bytes = readFileSync(info.path);
  if (bytes.length !== info.bytes) {
    throw new SlackError(
      "upload",
      "file_changed",
      `${info.path} changed since staging (${info.bytes} -> ${bytes.length} bytes). Re-stage it.`,
    );
  }
  const form = new FormData();
  form.append("file", new Blob([bytes]), info.name);
  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT },
      body: form,
    });
  } catch (error) {
    throw new SlackError("upload", "network_error", String(error));
  }
  if (!uploadResponse.ok) {
    const snippet = (await uploadResponse.text().catch(() => "")).slice(0, 200);
    throw new SlackError(
      "upload",
      `http_${uploadResponse.status}`,
      `Byte upload failed: ${snippet}`,
    );
  }

  const filesParam = JSON.stringify([
    { id: fileId, ...(options.title ? { title: options.title } : {}) },
  ]);
  await rawCall(creds, "files.completeUploadExternal", {
    files: filesParam,
    channel_id: channel,
    initial_comment: options.initialComment,
    thread_ts: options.threadTs,
  });

  // The complete call does not return the message ts; files.info shares do.
  let ts = "";
  try {
    const infoPayload = await rawCall(creds, "files.info", { file: fileId });
    const file = infoPayload.file as { shares?: Record<string, Record<string, Array<{ ts?: string }>>> } | undefined;
    const shares = file?.shares;
    if (shares) {
      outer: for (const scope of Object.values(shares)) {
        for (const [sharedChannel, entries] of Object.entries(scope)) {
          if (sharedChannel === channel && Array.isArray(entries) && entries[0]?.ts) {
            ts = String(entries[0].ts);
            break outer;
          }
        }
      }
    }
  } catch {
    // best-effort: the file is posted either way
  }
  return { channel, ts, file_id: fileId };
}
/**
 * Check the local catalog first: known-bad names fail fast with suggestions,
 * everything else is attempted live and the outcome is written back.
 */
function checkedEmojiName(input: string): string {
  const name = normalizeEmojiName(input);
  const known = lookupEmoji(name);
  if (known && known.slack === "no") {
    const suggestions = suggestEmoji(name);
    throw new SlackError(
      "reactions",
      "invalid_name",
      `"${input}" is not a Slack emoji.` +
        (suggestions.length ? ` Did you mean: ${suggestions.map((s) => `:${s}:`).join(" ")}?` : ""),
    );
  }
  return name;
}

export async function addReaction(
  creds: SlackCredentials,
  channel: string,
  ts: string,
  emoji: string,
): Promise<void> {
  const name = checkedEmojiName(emoji);
  try {
    await rawCall(creds, "reactions.add", {
      channel,
      timestamp: ts,
      name,
    });
    markEmojiOk(name);
  } catch (error) {
    if (error instanceof SlackError && error.code === "invalid_name") {
      markEmojiInvalid(name);
      const suggestions = suggestEmoji(name);
      throw new SlackError(
        "reactions.add",
        "invalid_name",
        `"${emoji}" is not a Slack emoji.` +
          (suggestions.length ? ` Did you mean: ${suggestions.map((s) => `:${s}:`).join(" ")}?` : ""),
      );
    }
    if (error instanceof SlackError && error.code === "already_reacted") {
      markEmojiOk(name); // the name is valid; it was just already there
    }
    throw error;
  }
}

export async function removeReaction(
  creds: SlackCredentials,
  channel: string,
  ts: string,
  emoji: string,
): Promise<void> {
  const name = checkedEmojiName(emoji);
  try {
    await rawCall(creds, "reactions.remove", {
      channel,
      timestamp: ts,
      name,
    });
    markEmojiOk(name);
  } catch (error) {
    if (error instanceof SlackError && error.code === "invalid_name") {
      markEmojiInvalid(name);
    }
    throw error;
  }
}

export async function searchMessages(
  creds: SlackCredentials,
  query: string,
  count: number,
  page: number,
): Promise<{ total: number; hits: SearchHit[] }> {
  const payload = await rawCall(creds, "search.messages", { query, count, page });
  const block = (payload.messages ?? {}) as {
    total?: number;
    matches?: Array<Record<string, unknown>>;
  };
  const hits: SearchHit[] = (block.matches ?? []).map((m) => {
    const channel = (m.channel ?? {}) as { id?: string; name?: string };
    return {
      ts: String(m.ts ?? ""),
      user: typeof m.user === "string" ? m.user : undefined,
      username: typeof m.username === "string" ? m.username : undefined,
      text: typeof m.text === "string" ? m.text : "",
      thread_ts: typeof m.thread_ts === "string" ? m.thread_ts : undefined,
      permalink: typeof m.permalink === "string" ? m.permalink : undefined,
      channel_id: channel.id,
      channel_name: channel.name,
    };
  });
  return { total: Number(block.total ?? hits.length), hits };
}

// --- output formatting (compact, context-cheap) -----------------------------

const MAX_TEXT = 1500;

function truncate(text: string): string {
  const clean = text.replace(/\r/g, "");
  return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) + "… [truncated]" : clean;
}

async function authorLabel(creds: SlackCredentials, m: SlackMessage): Promise<string> {
  if (m.bot_id) return m.username ? `${m.username} (bot)` : "bot";
  if (m.user) return `@${await displayName(creds, m.user)}`;
  return m.username ? `@${m.username}` : "unknown";
}

export async function formatMessage(creds: SlackCredentials, m: SlackMessage): Promise<string> {
  const author = await authorLabel(creds, m);
  const flags: string[] = [];
  if (m.edited) flags.push("edited");
  if (m.subtype && m.subtype !== "bot_message") flags.push(m.subtype);
  if (typeof m.reply_count === "number" && m.reply_count > 0) {
    flags.push(`${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"}`);
  }
  if (m.reactions?.length) {
    flags.push(m.reactions.map((r) => `:${r.name ?? "?"}:x${r.count ?? 1}`).join(" "));
  }
  const prefix = flags.length ? ` [${flags.join(" · ")}]` : "";
  const lines = [`[${m.ts}] ${author}${prefix}`, truncate(m.text ?? "")];
  if (m.thread_ts) {
    lines.push(`(in thread ${m.thread_ts})`);
  }
  if (m.files?.length) {
    for (const f of m.files) {
      lines.push(`[file: ${f.title || f.name || f.id}]`);
    }
  }
  return lines.join("\n");
}

export async function formatMessages(
  creds: SlackCredentials,
  messages: SlackMessage[],
  options: { reverse?: boolean } = {},
): Promise<string> {
  if (messages.length === 0) return "(no messages)";
  const ordered = options.reverse ? [...messages].reverse() : messages;
  const parts: string[] = [];
  for (const m of ordered) {
    parts.push(await formatMessage(creds, m));
  }
  return parts.join("\n\n---\n\n");
}

export async function formatSearchHit(creds: SlackCredentials, hit: SearchHit): Promise<string> {
  const author = hit.user
    ? `@${await displayName(creds, hit.user)}`
    : hit.username
      ? `@${hit.username}`
      : "unknown";
  const where = hit.channel_name
    ? `in #${hit.channel_name}${hit.channel_id ? ` (${hit.channel_id})` : ""}`
    : hit.channel_id
      ? `in ${hit.channel_id}`
      : "";
  const lines = [`[${hit.ts}] ${author} ${where}`.trimEnd(), truncate(hit.text ?? "")];
  if (hit.thread_ts) lines.push(`(in thread ${hit.thread_ts})`);
  if (hit.permalink) lines.push(hit.permalink);
  return lines.join("\n");
}
