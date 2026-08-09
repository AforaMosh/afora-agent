import { describe, expectTypeOf, it } from "vitest";
import type { BeforeAgentStartEvent, InputEvent } from "../agents/sessions/extensions/types.js";
import type { ExtensionAPI } from "./agent-sessions.js";
import type {
  ImageContent,
  MediaContent,
  Model,
  ModelInputContent,
  TextContent,
  UserMessage,
  VideoContent,
} from "./llm.js";
import type { ProviderRuntimeModel } from "./plugin-entry.js";

describe("plugin SDK multimodal LLM contracts", () => {
  it("exposes native video as normalized model media and user input", () => {
    expectTypeOf<MediaContent>().toEqualTypeOf<ImageContent | VideoContent>();
    expectTypeOf<ModelInputContent>().toEqualTypeOf<TextContent | ImageContent | VideoContent>();
    expectTypeOf<Model["input"][number]>().toEqualTypeOf<"text" | "image" | "video">();
    expectTypeOf<UserMessage["content"]>().toEqualTypeOf<string | ModelInputContent[]>();
  });

  it("keeps the public provider-authoring contract aligned with canonical LLM media", () => {
    expectTypeOf<ProviderRuntimeModel["input"][number]>().toEqualTypeOf<
      "text" | "image" | "video"
    >();
  });

  it("exposes native media while preserving released image-only extension hooks", () => {
    expectTypeOf<Parameters<ExtensionAPI["sendUserMessage"]>[0]>().toEqualTypeOf<
      string | ModelInputContent[]
    >();
    expectTypeOf<
      NonNullable<
        Parameters<ExtensionAPI["registerProvider"]>[1]["models"]
      >[number]["input"][number]
    >().toEqualTypeOf<"text" | "image" | "video">();
    expectTypeOf<InputEvent["media"]>().toEqualTypeOf<MediaContent[] | undefined>();
    expectTypeOf<InputEvent["images"]>().toEqualTypeOf<ImageContent[] | undefined>();
    expectTypeOf<BeforeAgentStartEvent["media"]>().toEqualTypeOf<MediaContent[] | undefined>();
  });
});
