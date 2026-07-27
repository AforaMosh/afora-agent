// Google shared conversion tests cover runtime-to-Google payload conversion.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { Context, Tool } from "../types.js";
import { convertMessages, convertTools } from "./google-shared.js";
import {
  asRecord,
  expectConvertedRoles,
  getFirstToolParameters,
  makeGeminiCliAssistantMessage,
  makeGeminiCliModel,
  makeGoogleAssistantMessage,
  makeModel,
} from "./google-shared.test-helpers.js";

type GoogleSharedTestModel = ReturnType<typeof makeModel> | ReturnType<typeof makeGeminiCliModel>;
const convertMessagesForModel = convertMessages as unknown as (
  model: GoogleSharedTestModel,
  context: Context,
) => ReturnType<typeof convertMessages>;

function convertTestMessages(model: GoogleSharedTestModel, messages: unknown[]) {
  return convertMessagesForModel(model, { messages } as unknown as Context);
}

function requireRecordProperty(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object property " + key);
  }
  return value as Record<string, unknown>;
}

function requireFunctionPart(
  contents: ReturnType<typeof convertMessages>,
  property: "functionCall" | "functionResponse",
  index?: number,
) {
  const blocks =
    index === undefined
      ? contents.flatMap((content) => content.parts ?? [])
      : contents[index]?.parts;
  const part = blocks?.find(
    (block) => typeof block === "object" && block !== null && property in block,
  );
  return requireRecordProperty(
    asRecord(expectDefined(part, property + " test invariant")),
    property,
  );
}

describe("google-shared convertTools", () => {
  const schemaCases: Array<{
    name: string;
    toolName: string;
    description: string;
    parameters: Record<string, unknown>;
    missingType?: boolean;
  }> = [
    {
      name: "preserves parameters when type is missing",
      toolName: "noType",
      description: "Tool with properties but no type",
      parameters: { properties: { action: { type: "string" } }, required: ["action"] },
      missingType: true,
    },
    {
      name: "keeps unsupported JSON Schema keywords intact",
      toolName: "example",
      description: "Example tool",
      parameters: {
        type: "object",
        patternProperties: { "^x-": { type: "string" } },
        additionalProperties: false,
        properties: {
          mode: { type: "string", const: "fast" },
          options: { anyOf: [{ type: "string" }, { type: "number" }] },
          list: { type: "array", items: { type: "string", const: "item" } },
        },
        required: ["mode"],
      },
    },
    {
      name: "keeps supported schema fields",
      toolName: "settings",
      description: "Settings tool",
      parameters: {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              retries: { type: "number", minimum: 1 },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["retries"],
          },
        },
        required: ["config"],
      },
    },
  ];

  it.each(schemaCases)("$name", ({ toolName, description, parameters, missingType }) => {
    const converted = convertTools([
      { name: toolName, description, parameters },
    ] as unknown as Tool[]);
    const actual = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );
    expect(actual).toMatchObject(parameters);
    if (missingType) {
      expect(actual.type).toBeUndefined();
    }
  });
});

describe("google-shared convertMessages", () => {
  it.each([
    {
      name: "keeps thinking blocks when provider/model match",
      modelId: "gemini-1.5-pro",
      thinking: "hidden",
    },
    {
      name: "keeps thought signatures for Claude models",
      modelId: "claude-3-opus",
      thinking: "structured",
    },
  ])("$name", ({ modelId, thinking }) => {
    const model = makeModel(modelId);
    const contents = convertTestMessages(model, [
      makeGoogleAssistantMessage(model.id, [
        { type: "thinking", thinking, thinkingSignature: "c2ln" },
      ]),
    ]);
    expectConvertedRoles(contents, ["model"]);
    const parts = expectDefined(contents[0], "thinking content test invariant").parts ?? [];
    expect(parts).toHaveLength(1);
    expect(asRecord(parts[0])).toMatchObject({ thought: true, thoughtSignature: "c2ln" });
  });

  it.each([
    {
      name: "does not merge consecutive user messages for Gemini",
      modelId: "gemini-1.5-pro",
      first: "Hello",
      second: "How are you?",
    },
    {
      name: "does not merge consecutive user messages for non-Gemini Google models",
      modelId: "claude-3-opus",
      first: "First",
      second: "Second",
    },
  ])("$name", ({ modelId, first, second }) => {
    const contents = convertTestMessages(makeModel(modelId), [
      { role: "user", content: first },
      { role: "user", content: second },
    ]);
    expectConvertedRoles(contents, ["user", "user"]);
    for (const content of contents) {
      expect(content.parts).toHaveLength(1);
    }
  });

  it("does not merge consecutive model messages for Gemini", () => {
    const model = makeModel("gemini-1.5-pro");
    const contents = convertTestMessages(model, [
      { role: "user", content: "Hello" },
      makeGoogleAssistantMessage(model.id, [{ type: "text", text: "Hi there!" }]),
      makeGoogleAssistantMessage(model.id, [{ type: "text", text: "How can I help?" }]),
    ]);
    expectConvertedRoles(contents, ["user", "model", "model"]);
    expect(contents[1]?.parts).toHaveLength(1);
    expect(contents[2]?.parts).toHaveLength(1);
  });

  it("handles user message after tool result without model response in between", () => {
    const model = makeModel("gemini-1.5-pro");
    const contents = convertTestMessages(model, [
      { role: "user", content: "Use a tool" },
      makeGoogleAssistantMessage(model.id, [
        { type: "toolCall", id: "call_1", name: "myTool", arguments: { arg: "value" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "myTool",
        content: [{ type: "text", text: "Tool result" }],
        isError: false,
        timestamp: 0,
      },
      { role: "user", content: "Now do something else" },
    ]);
    expectConvertedRoles(contents, ["user", "model", "user", "user"]);
    expect(requireFunctionPart(contents, "functionResponse", 2).name).toBe("myTool");
  });

  it("ensures function call comes after user turn, not after model turn", () => {
    const model = makeModel("gemini-1.5-pro");
    const contents = convertTestMessages(model, [
      { role: "user", content: "Hello" },
      makeGoogleAssistantMessage(model.id, [{ type: "text", text: "Hi!" }]),
      makeGoogleAssistantMessage(model.id, [
        { type: "toolCall", id: "call_1", name: "myTool", arguments: {} },
      ]),
    ]);
    expectConvertedRoles(contents, ["user", "model", "model", "user"]);
    expect(requireFunctionPart(contents, "functionCall", 2).name).toBe("myTool");
  });

  it("strips tool call and response ids for google-gemini-cli", () => {
    const model = makeGeminiCliModel("gemini-3-flash");
    const contents = convertTestMessages(model, [
      { role: "user", content: "Use a tool" },
      makeGeminiCliAssistantMessage(model.id, [
        {
          type: "toolCall",
          id: "call_1",
          name: "myTool",
          arguments: { arg: "value" },
          thoughtSignature: "dGVzdA==",
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "myTool",
        content: [{ type: "text", text: "Tool result" }],
        isError: false,
        timestamp: 0,
      },
    ]);
    expect(requireFunctionPart(contents, "functionCall").id).toBeUndefined();
    expect(requireFunctionPart(contents, "functionResponse").id).toBeUndefined();
  });

  it("serializes structured tool results into function responses", () => {
    const contents = convertTestMessages(makeModel("gemini-1.5-pro"), [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "session_status",
        content: [{ type: "json", payload: { sessionKey: "current", status: "ok" } }],
        isError: false,
        timestamp: 0,
      },
    ]);
    const response = requireFunctionPart(contents, "functionResponse", 0);
    expect(asRecord(response.response).output).toBe(
      '{"type":"json","payload":{"sessionKey":"current","status":"ok"}}',
    );
  });

  it("does not emit inline data or media placeholders for payload-less tool images", () => {
    const contents = convertTestMessages(makeModel("gemini-3-flash"), [
      {
        role: "toolResult",
        toolCallId: "call_husk",
        toolName: "screenshot",
        content: [{ type: "image", mimeType: "image/png", data: "" }],
        isError: false,
        timestamp: 0,
      },
    ]);
    const serialized = JSON.stringify(contents);
    expect(serialized).toContain('"output":""');
    expect(serialized).not.toContain("inlineData");
    expect(serialized).not.toContain("see attached image");
  });
});
