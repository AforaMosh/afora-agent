/**
 * Aggregate summaries and live labels for a run of consecutive tool calls.
 */

import { i18n, t } from "../../i18n/index.ts";
import {
  resolveToolCallView,
  resolveToolCallFileOperations,
  resolveToolCallKind,
  resolveToolCallTargetPaths,
  type ToolCallKind,
} from "./tool-call-view.ts";

type ToolGroupSummaryInput = {
  name: string;
  args?: unknown;
};

type FileActivity = "read" | "edit" | "write" | "delete";

type FileActivityCounts = {
  calls: number;
  paths: Set<string>;
};

type GroupCounts = {
  commands: number;
  files: Record<FileActivity, FileActivityCounts>;
  searches: number;
  webSearches: number;
  fetches: number;
  others: number;
};

const WEB_SEARCH_TOOL_NAMES = new Set(["web_search", "websearch", "search_web"]);

function isWebSearch(name: string): boolean {
  return WEB_SEARCH_TOOL_NAMES.has(name.trim().toLowerCase());
}

function countFiles(counts: GroupCounts, activity: FileActivity, paths: readonly string[]): void {
  const target = counts.files[activity];
  target.calls += 1;
  for (const path of paths) {
    if (path.trim()) {
      target.paths.add(path.trim());
    }
  }
}

function countCard(counts: GroupCounts, card: ToolGroupSummaryInput): void {
  if (isWebSearch(card.name)) {
    counts.webSearches += 1;
    return;
  }
  const kind: ToolCallKind = resolveToolCallKind(card.name, card.args);
  const fileOperations = resolveToolCallFileOperations(card.name, card.args);
  if (fileOperations) {
    for (const { operation, path } of fileOperations) {
      const activity = operation === "add" ? "write" : operation === "delete" ? "delete" : "edit";
      countFiles(counts, activity, [path]);
    }
  } else {
    const pathKeys = resolveToolCallTargetPaths(card.name, card.args);
    switch (kind) {
      case "command":
        counts.commands += 1;
        break;
      case "read":
        countFiles(counts, "read", pathKeys);
        break;
      case "edit":
        countFiles(counts, "edit", pathKeys);
        break;
      case "write":
        countFiles(counts, "write", pathKeys);
        break;
      case "search":
        counts.searches += 1;
        break;
      case "fetch":
        counts.fetches += 1;
        break;
      default:
        counts.others += 1;
    }
  }
}

function countLabel(count: number, oneKey: string, manyKey: string): string {
  return t(count === 1 ? oneKey : manyKey);
}

function fileCount(calls: number, paths: Set<string>): number {
  return paths.size > 0 ? paths.size : calls;
}

/**
 * Build the collapsed group label. Counts select grammar but are not shown.
 */
export function summarizeToolGroup(cards: readonly ToolGroupSummaryInput[]): string {
  const counts: GroupCounts = {
    commands: 0,
    files: {
      read: { calls: 0, paths: new Set() },
      edit: { calls: 0, paths: new Set() },
      write: { calls: 0, paths: new Set() },
      delete: { calls: 0, paths: new Set() },
    },
    searches: 0,
    webSearches: 0,
    fetches: 0,
    others: 0,
  };
  for (const card of cards) {
    countCard(counts, card);
  }

  const segments: string[] = [];
  if (counts.others > 0) {
    segments.push(
      countLabel(counts.others, "chat.toolCards.group.otherOne", "chat.toolCards.group.otherMany"),
    );
  }
  const fileLabels = [
    ["edit", "editsOne", "editsMany"],
    ["write", "writesOne", "writesMany"],
    ["delete", "deletesOne", "deletesMany"],
    ["read", "readsOne", "readsMany"],
  ] as const;
  for (const [activity, one, many] of fileLabels) {
    const { calls, paths } = counts.files[activity];
    if (calls > 0) {
      segments.push(
        countLabel(
          fileCount(calls, paths),
          `chat.toolCards.group.${one}`,
          `chat.toolCards.group.${many}`,
        ),
      );
    }
  }
  if (counts.searches > 0) {
    segments.push(
      countLabel(
        counts.searches,
        "chat.toolCards.group.fileSearchesOne",
        "chat.toolCards.group.fileSearchesMany",
      ),
    );
  }
  if (counts.commands > 0) {
    segments.push(
      countLabel(
        counts.commands,
        "chat.toolCards.group.commandsOne",
        "chat.toolCards.group.commandsMany",
      ),
    );
  }
  if (counts.webSearches > 0) {
    segments.push(
      countLabel(
        counts.webSearches,
        "chat.toolCards.group.searchesOne",
        "chat.toolCards.group.searchesMany",
      ),
    );
  }
  if (counts.fetches > 0) {
    segments.push(
      countLabel(
        counts.fetches,
        "chat.toolCards.group.fetchesOne",
        "chat.toolCards.group.fetchesMany",
      ),
    );
  }

  if (segments.length === 0) {
    return t("chat.toolCards.group.worked");
  }
  const label = new Intl.ListFormat(i18n.getLocale(), {
    style: "long",
    type: "conjunction",
  }).format(segments);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function summarizeActiveTool(card: ToolGroupSummaryInput): string {
  if (isWebSearch(card.name)) {
    return t("chat.toolCards.group.searchingWeb");
  }
  const view = resolveToolCallView({ name: card.name, args: card.args });
  if (view.kind === "command") {
    return t("chat.toolCards.group.runningCommand", {
      command: view.command?.split("\n")[0]?.trim() || card.name,
    });
  }
  if (view.kind === "read" || view.kind === "fetch") {
    return t("chat.toolCards.group.readingTarget", { target: view.target || card.name });
  }
  if (view.kind === "edit" || view.kind === "write") {
    return t("chat.toolCards.group.editingFiles");
  }
  if (view.kind === "search") {
    return t("chat.toolCards.group.searchingFiles");
  }
  return t("chat.toolCards.group.usingTool", { tool: card.name });
}
