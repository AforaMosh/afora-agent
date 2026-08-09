import { isVideoMediaFact, readPersistedMediaFacts } from "../../media/media-facts.js";
import type { SessionEntry } from "./session-manager.js";

function isFactsOnlyUserMessage(
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "message" }> {
  if (entry.type !== "message" || entry.message.role !== "user") {
    return false;
  }
  const content = entry.message.content;
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  return content.every(
    (block) => block.type === "text" && (typeof block.text !== "string" || !block.text.trim()),
  );
}

/** Makes reference-only video turns visible to compaction without exposing reference details. */
export function projectSessionCompactionMedia(entries: SessionEntry[]): SessionEntry[] {
  let projected: SessionEntry[] | undefined;
  for (const [index, entry] of entries.entries()) {
    if (!isFactsOnlyUserMessage(entry)) {
      continue;
    }
    const videoCount = (readPersistedMediaFacts(entry.message) ?? []).filter(
      isVideoMediaFact,
    ).length;
    if (videoCount === 0) {
      continue;
    }
    projected ??= entries.slice();
    projected[index] = {
      ...entry,
      message: {
        ...entry.message,
        content: `[video attachment${videoCount === 1 ? "" : "s"} retained by reference: ${videoCount}]`,
      },
    };
  }
  return projected ?? entries;
}
