/**
 * Build %USERPROFILE%/.config/slack-mcp/emoji.json from the iamcal emoji-data
 * set (Slack-style short names -> character). Built-in names start as
 * slack:"unknown" and are confirmed on demand the first time something
 * actually uses them; names Slack rejects are recorded as "no" so we never
 * look them up again.
 *
 * Run: npm run emoji:build
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { emojiFilePath, type EmojiCatalog } from "./emoji.js";

const SOURCE_URL =
  "https://raw.githubusercontent.com/iamcal/emoji-data/master/emoji.json";

// Names personally verified against this workspace's Slack.
const KNOWN_GOOD: Record<string, string> = {
  o2: "🅾️",
  copyright: "©️",
};

interface RawEntry {
  short_name?: string;
  short_names?: string[];
  name?: string;
  unified?: string;
}

function charFromUnified(unified: string): string {
  try {
    return String.fromCodePoint(
      ...unified.split("-").map((h) => parseInt(h, 16)),
    );
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  console.log(`downloading ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  const raw = (await res.json()) as Array<Record<string, unknown>>;

  const emoji: EmojiCatalog["emoji"] = {};
  for (const entry of raw) {
    const e = entry as RawEntry;
    const char =
      typeof e.unified === "string" ? charFromUnified(e.unified) : "";
    if (!char) continue;
    const names = new Set<string>();
    if (typeof e.short_name === "string") names.add(e.short_name);
    for (const alias of e.short_names ?? []) names.add(alias);
    for (const name of names) {
      const key = name.toLowerCase();
      if (!emoji[key]) {
        emoji[key] = { char, slack: "unknown", custom: false };
      }
    }
  }

  for (const [name, char] of Object.entries(KNOWN_GOOD)) {
    emoji[name] = { char, slack: "ok", custom: false };
  }

  // Preserve anything learned since the last build: workspace custom emoji
  // and on-demand ok/no verdicts.
  if (existsSync(emojiFilePath())) {
    try {
      const prev = JSON.parse(
        readFileSync(emojiFilePath(), "utf8"),
      ) as EmojiCatalog;
      for (const [name, entry] of Object.entries(prev.emoji ?? {})) {
        if (entry.custom || entry.slack !== "unknown") {
          emoji[name] = entry;
        }
      }
    } catch {
      // Corrupt catalog: rebuild clean.
    }
  }

  const catalog: EmojiCatalog = {
    generated_at: new Date().toISOString(),
    sources: ["iamcal/emoji-data"],
    total: Object.keys(emoji).length,
    emoji,
  };
  if (!catalog.sources.includes("emoji.list") && Object.values(emoji).some((e) => e.custom)) {
    catalog.sources.push("emoji.list");
  }

  writeFileSync(emojiFilePath(), JSON.stringify(catalog) + "\n", "utf8");
  console.log(`wrote ${emojiFilePath()} with ${catalog.total} names`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
