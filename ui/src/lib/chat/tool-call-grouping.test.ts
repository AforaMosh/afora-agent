// Control UI tests cover collapsed tool-group summary labels.
import { describe, expect, it } from "vitest";
import { summarizeActiveTool, summarizeToolGroup } from "./tool-call-grouping.ts";

type ToolGroupSummaryInput = Parameters<typeof summarizeToolGroup>[0][number];

describe("summarizeToolGroup", () => {
  it.each<[string, ToolGroupSummaryInput[], string]>([
    ["a single command", [{ name: "bash", args: { command: "ls" } }], "Ran a command"],
    [
      "distinct paths over call count",
      [
        { name: "read", args: { path: "/repo/a.ts" } },
        { name: "read", args: { path: "/repo/a.ts" } },
        { name: "read", args: { path: "/repo/b.ts" } },
      ],
      "Read files",
    ],
    [
      "call count when reads carry no paths",
      [
        { name: "read", args: {} },
        { name: "read", args: {} },
      ],
      "Read files",
    ],
    [
      "multiple searches",
      [
        { name: "grep", args: { pattern: "a" } },
        { name: "glob", args: { pattern: "b" } },
      ],
      "Searched files",
    ],
    [
      "fixed semantic order across categories",
      [
        { name: "web_search", args: { query: "disclosures" } },
        { name: "exec", args: { command: "pnpm check" } },
        { name: "read", args: { path: "/repo/a.ts" } },
        {
          name: "apply_patch",
          args: { changes: [{ path: "/repo/a.ts", kind: { type: "update" } }] },
        },
      ],
      "Edited a file, read a file, ran a command, and searched the web",
    ],
    [
      "command-discriminated text editor calls",
      [
        {
          name: "str_replace_editor",
          args: { command: "view", file_path: "/repo/a.ts", view_range: [1, 20] },
        },
        {
          name: "str_replace_based_edit_tool",
          args: {
            command: "str_replace",
            file: "/repo/a.ts",
            old_str: "old",
            new_str: "new",
          },
        },
        {
          name: "str_replace_editor",
          args: { command: "insert", filepath: "/repo/a.ts", insert_text: "line" },
        },
        {
          name: "str_replace_based_edit_tool",
          args: { command: "create", filename: "/repo/new.ts", file_text: "new" },
        },
      ],
      "Edited a file, created a file, and read a file",
    ],
    [
      "text editor calls without a recognized command",
      [
        { name: "str_replace_editor", args: { path: "/repo/a.ts" } },
        { name: "str_replace_based_edit_tool", args: { command: "rename" } },
      ],
      "Used tools",
    ],
    [
      "multi-file apply_patch targets",
      [
        {
          name: "apply_patch",
          args: {
            patch: [
              "*** Begin Patch",
              "*** Update File: src/a.ts",
              "@@",
              "-old",
              "+new",
              "*** Add File: src/b.ts",
              "+new",
              "*** End Patch",
            ].join("\n"),
          },
        },
      ],
      "Edited a file and created a file",
    ],
    [
      "structured Codex change targets",
      [
        {
          name: "apply_patch",
          args: {
            changes: [
              { path: "src/a.ts", kind: { type: "update" } },
              { path: "src/b.ts", kind: { type: "add" } },
            ],
          },
        },
      ],
      "Edited a file and created a file",
    ],
    [
      "deleted Codex targets",
      [
        {
          name: "apply_patch",
          args: {
            changes: [{ path: "src/obsolete.ts", kind: { type: "delete" } }],
          },
        },
      ],
      "Deleted a file",
    ],
    ["one generic tool", [{ name: "mcp__linear" }], "Used a tool"],
    [
      "repeat generic tool with a multiplier",
      [{ name: "mcp__linear" }, { name: "mcp__linear" }],
      "Used tools",
    ],
    [
      "many distinct generic tools as a count",
      [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
      "Used tools",
    ],
  ])("summarizes %s", (_label, cards, expected) => {
    expect(summarizeToolGroup(cards)).toBe(expected);
  });
});

describe("summarizeActiveTool", () => {
  it.each<[string, ToolGroupSummaryInput, string]>([
    ["command", { name: "exec", args: { command: "pnpm check" } }, "Running pnpm check"],
    ["file read", { name: "read", args: { path: "/repo/a.ts" } }, "Reading a.ts"],
    [
      "file edit",
      {
        name: "apply_patch",
        args: { changes: [{ path: "/repo/a.ts", kind: { type: "update" } }] },
      },
      "Editing files",
    ],
    ["local search", { name: "grep", args: { pattern: "activity" } }, "Searching files"],
    ["web search", { name: "web_search", args: { query: "activity" } }, "Searching the web"],
    ["unknown tool", { name: "custom_tool", args: {} }, "Using custom_tool"],
  ])("labels %s conservatively", (_label, card, expected) => {
    expect(summarizeActiveTool(card)).toBe(expected);
  });
});
