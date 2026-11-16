/**
 * Local emoji catalog: every built-in colon-name Slack understands, plus
 * workspace custom emoji merged in on every sync.
 *
 * Lookup order for a name: local emoji.json first. Anything missing or
 * unvalidated is resolved on demand against Slack itself, and the result
 * (works / invalid_name) is written back — so the file only grows, and only
 * with names something actually tried to use.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { configDir } from "./credentials.js";

export type EmojiStatus = "ok" | "no" | "unknown";

export interface EmojiEntry {
  char: string;
  slack: EmojiStatus;
  custom: boolean;
}

export interface EmojiCatalog {
  generated_at: string;
  sources: string[];
  total: number;
  emoji: Record<string, EmojiEntry>;
}

export function emojiFilePath(): string {
  return join(configDir(), "emoji.json");
}

export function readEmojiCatalog(): EmojiCatalog | null {
  seedCatalogIfMissing();
  try {
    if (!existsSync(emojiFilePath())) return null;
    const parsed = JSON.parse(readFileSync(emojiFilePath(), "utf8")) as EmojiCatalog;
    if (!parsed || typeof parsed.emoji !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCatalog(catalog: EmojiCatalog): void {
  mkdirSync(configDir(), { recursive: true });
  catalog.generated_at = new Date().toISOString();
  catalog.total = Object.keys(catalog.emoji).length;
  const tmp = `${emojiFilePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(catalog) + "\n", "utf8");
  renameSync(tmp, emojiFilePath());
}

/**
 * First-run seed: copy the committed built-in catalog (assets/emoji.json)
 * into the config dir so suggestions work offline. Never overwrites an
 * existing file — learned verdicts and workspace custom emoji are kept.
 */
function seedCatalogIfMissing(): void {
  try {
    if (existsSync(emojiFilePath())) return;
    const here = dirname(fileURLToPath(import.meta.url));
    const seed = join(here, "..", "assets", "emoji.json");
    if (!existsSync(seed)) return;
    const parsed = JSON.parse(readFileSync(seed, "utf8")) as EmojiCatalog;
    if (!parsed || typeof parsed.emoji !== "object") return;
    saveCatalog(parsed);
  } catch {
    // Seeding is best-effort; lookups degrade to live validation.
  }
}

/** Normalize what a person types into a Slack emoji name. */
export function normalizeEmojiName(input: string): string {
  return input.trim().toLowerCase().replace(/^:+|:+$/g, "").replace(/\s+/g, "_");
}

export function lookupEmoji(
  name: string,
): (EmojiEntry & { name: string }) | null {
  const catalog = readEmojiCatalog();
  if (!catalog) return null;
  const key = normalizeEmojiName(name);
  const entry = catalog.emoji[key];
  return entry ? { name: key, ...entry } : null;
}

function upsertEmojiEntry(name: string, patch: Partial<EmojiEntry>): void {
  try {
    const catalog = readEmojiCatalog() ?? {
      generated_at: new Date().toISOString(),
      sources: ["on-demand"],
      total: 0,
      emoji: {},
    };
    const key = normalizeEmojiName(name);
    const prev = catalog.emoji[key] ?? { char: "", slack: "unknown", custom: false };
    catalog.emoji[key] = { ...prev, ...patch };
    if (!catalog.sources.includes("on-demand")) {
      catalog.sources.push("on-demand");
    }
    saveCatalog(catalog);
  } catch {
    // Catalog writes must never break a call.
  }
}

/** Record that Slack accepted this name (custom or built-in). */
export function markEmojiOk(name: string, char = ""): void {
  const prev = lookupEmoji(name);
  upsertEmojiEntry(name, {
    slack: "ok",
    ...(char && !(prev?.char) ? { char } : {}),
  });
}

/** Record that Slack rejected this name. */
export function markEmojiInvalid(name: string): void {
  upsertEmojiEntry(name, { slack: "no" });
}

/** Merge workspace custom emoji (from emoji.list) into the catalog. */
export function mergeCustomEmoji(entries: Record<string, string>): number {
  let added = 0;
  try {
    const catalog = readEmojiCatalog() ?? {
      generated_at: new Date().toISOString(),
      sources: ["on-demand"],
      total: 0,
      emoji: {},
    };
    if (!catalog.sources.includes("emoji.list")) {
      catalog.sources.push("emoji.list");
    }
    for (const [name, url] of Object.entries(entries)) {
      const key = normalizeEmojiName(name);
      if (!catalog.emoji[key]) added++;
      // Alias values look like "alias:other-name"; keep the pointer as-is.
      catalog.emoji[key] = { char: url, slack: "ok", custom: true };
    }
    saveCatalog(catalog);
  } catch {
    // ignore
  }
  return added;
}

/**
 * Suggest alternatives for an unknown/rejected name: substring matches first,
 * then any entry sharing a token (so "regional_indicator_o" suggests :o:).
 */
export function suggestEmoji(name: string, max = 8): string[] {
  const catalog = readEmojiCatalog();
  if (!catalog) return [];
  const key = normalizeEmojiName(name);
  const keys = Object.keys(catalog.emoji).filter(
    (k) => catalog.emoji[k].slack !== "no",
  );
  const sub = keys.filter((k) => k.includes(key)).slice(0, max);
  if (sub.length > 0) return sub;
  const tokens = key.split(/_+/).filter((t) => t.length > 0);
  const scored: Array<[number, string]> = [];
  for (const t of tokens) {
    if (t === "regional" || t === "indicator" || t === "symbol" || t === "letter") {
      continue;
    }
    for (const k of keys) {
      if (scored.some(([, name]) => name === k)) continue;
      const parts = k.split(/_+/);
      // Single-letter tokens only match exact/prefix (else "o" matches
      // "jack_o_lantern" and drowns the real answers).
      if (k === t || (t.length > 1 && parts.includes(t))) {
        scored.push([2, k]);
      } else if (k.startsWith(t)) {
        scored.push([1, k]);
      }
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, max).map(([, name]) => name);
}
