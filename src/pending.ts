/**
 * Staged (preview-before-send) actions.
 *
 * Nothing leaves the device from here: stage-only tools validate, resolve,
 * and record the exact payload, then return a preview + action_id. Only
 * `confirm` executes it — and it executes the stored payload verbatim (it
 * takes no text/emoji/file arguments, so what was previewed is provably
 * what gets sent). Entries are single-use and expire after PENDING_TTL_MS.
 */
import { randomUUID } from "crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { configDir } from "./credentials.js";

/** Staged sends die after 5 minutes without confirmation. */
export const PENDING_TTL_MS = 5 * 60 * 1000;

export type PendingAction = "send" | "edit" | "reaction" | "unreact" | "upload";

export interface PendingEntry {
  id: string;
  action: PendingAction;
  channel_id: string;
  channel_label: string;
  kind: string;
  /** send: full mrkdwn text. edit: replacement text. upload: initial_comment. */
  text?: string;
  /** send/edit: validated Block Kit array (re-serialized at confirm time). */
  blocks?: unknown[];
  thread_ts?: string;
  unfurl_links?: boolean;
  /** edit/reaction target message. */
  ts?: string;
  /** reaction name (no colons) + catalog char for the preview. */
  emoji?: string;
  emoji_char?: string;
  /** upload details. */
  file_path?: string;
  file_name?: string;
  file_title?: string;
  file_bytes?: number;
  created_at: string;
  expires_at: string;
}

export function pendingFilePath(): string {
  return join(configDir(), "pending.json");
}

function readAll(): PendingEntry[] {
  try {
    if (!existsSync(pendingFilePath())) return [];
    const parsed = JSON.parse(readFileSync(pendingFilePath(), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as PendingEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: PendingEntry[]): void {
  const tmp = `${pendingFilePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", "utf8");
  renameSync(tmp, pendingFilePath());
}

/** Drop expired entries. Returns the ids that were expired (not cancelled). */
export function prunePending(): string[] {
  const now = Date.now();
  const entries = readAll();
  const expired = entries.filter((e) => Date.parse(e.expires_at) <= now).map((e) => e.id);
  if (expired.length > 0) {
    writeAll(entries.filter((e) => !expired.includes(e.id)));
  }
  return expired;
}

export function listPending(): PendingEntry[] {
  prunePending();
  return readAll().sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function stagePending(
  entry: Omit<PendingEntry, "id" | "created_at" | "expires_at">,
): PendingEntry {
  prunePending();
  const now = new Date();
  const full: PendingEntry = {
    ...entry,
    id: randomUUID().slice(0, 8),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
  };
  const entries = readAll();
  entries.push(full);
  // Bound growth: keep the newest 50.
  writeAll(entries.slice(-50));
  return full;
}

/** Single-use take: the entry is removed whether execution succeeds or not. */
export function takePending(id: string): PendingEntry | null {
  prunePending();
  const entries = readAll();
  const found = entries.find((e) => e.id === id) ?? null;
  if (found) {
    writeAll(entries.filter((e) => e.id !== id));
  }
  return found;
}

export function cancelPending(id: string): PendingEntry | null {
  prunePending();
  const entries = readAll();
  const found = entries.find((e) => e.id === id) ?? null;
  if (found) {
    writeAll(entries.filter((e) => e.id !== id));
  }
  return found;
}

/** Re-stage after a failed confirm so the user can retry without rebuilding. */
export function restagePending(
  entry: Omit<PendingEntry, "id" | "created_at" | "expires_at">,
): PendingEntry {
  return stagePending(entry);
}

function minutesLeft(entry: PendingEntry): string {
  const ms = Date.parse(entry.expires_at) - Date.now();
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

/** Exact, copy-pasteable preview of what confirm() will do. */
export function formatPreview(entry: PendingEntry): string {
  const lines: string[] = [];
  lines.push(`PENDING ${entry.action}  id=${entry.id}  (expires in ${minutesLeft(entry)})`);
  lines.push(`to: ${entry.channel_label} (${entry.channel_id}, ${entry.kind})`);
  if (entry.thread_ts) lines.push(`thread: ${entry.thread_ts}`);
  if (entry.ts && entry.action !== "reaction") lines.push(`message ts: ${entry.ts}`);
  if (entry.action === "reaction" || entry.action === "unreact") {
    const verb = entry.action === "reaction" ? "react" : "remove";
    lines.push(
      `${verb} :${entry.emoji}: ${entry.emoji_char ?? ""} ${entry.action === "reaction" ? "on" : "from"} message ${entry.ts}`,
    );
  }
  if (entry.text) {
    lines.push(`<<<`);
    lines.push(entry.text);
    lines.push(`>>> (${entry.text.length} chars)`);
  }
  if (entry.blocks && entry.blocks.length > 0) {
    const types = entry.blocks
      .map((b) => (b as { type?: string }).type ?? "?")
      .join(", ");
    lines.push(`blocks: ${entry.blocks.length} [${types}] (text above is the fallback)`);
  }
  if (entry.action === "upload") {
    const kb = entry.file_bytes != null ? ` (${(entry.file_bytes / 1024).toFixed(1)} KB)` : "";
    lines.push(`file: ${entry.file_name ?? entry.file_path}${kb}`);
    if (entry.file_title) lines.push(`title: ${entry.file_title}`);
    if (entry.file_path) lines.push(`path: ${entry.file_path}`);
  }
  lines.push(`confirm with: confirm ${entry.id}   |   discard with: cancel ${entry.id}`);
  return lines.join("\n");
}
