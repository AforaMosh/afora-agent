import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { describe, expect, it } from "vitest";
import { projectMcpContentBlocks, projectMcpJsonValue } from "./mcp-content.js";

describe("projectMcpContentBlocks images", () => {
  it("returns valid image data in canonical base64 form", () => {
    expect(
      projectMcpContentBlocks([{ type: "image", data: "aGVs bG8=\n", mimeType: "IMAGE/PNG" }]),
    ).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
  });

  it("omits invalid base64 image data", () => {
    expect(
      projectMcpContentBlocks([{ type: "image", data: "not%base64", mimeType: "image/png" }]),
    ).toEqual([{ type: "text", text: "[image omitted: invalid MCP image]" }]);
  });

  it("omits encoded image input above the raw allocation cap", () => {
    const data = "AAAA".repeat(MAX_IMAGE_BYTES / 3 + 1);

    expect(projectMcpContentBlocks([{ type: "image", data, mimeType: "image/png" }])).toEqual([
      { type: "text", text: "[image omitted: invalid MCP image]" },
    ]);
  });
});

describe("projectMcpJsonValue media aliases", () => {
  it.each([
    "audio",
    "audio_url",
    "image",
    "image_url",
    "input_audio",
    "input_image",
    "input_video",
    "output_audio",
    "video",
    "video_url",
  ])("omits direct %s data", (type) => {
    const payload = Buffer.from(`private-${type}`).toString("base64");

    const projected = projectMcpJsonValue({ type, data: payload, label: type });

    expect(projected).toEqual({ type, data: "[binary omitted]", label: type });
    expect(JSON.stringify(projected)).not.toContain(payload);
  });

  it("inherits media context through named containers, arrays, and nested records", () => {
    const inputVideo = Buffer.from("private-input-video").toString("base64");
    const outputAudio = Buffer.from("private-output-audio").toString("base64");
    const nestedAudio = Buffer.from("private-nested-audio").toString("base64");
    const inputImage = Buffer.from("private-input-image").toString("base64");
    const unrelatedData = "ordinary application data";

    const projected = projectMcpJsonValue({
      input_video: { data: inputVideo, format: "mp4" },
      output_audio: {
        audio: [{ data: outputAudio, format: "mp3" }, { nested: [{ blob: nestedAudio }] }],
      },
      image_url: [{ data: inputImage, mime_type: "image/png" }],
      metadata: { data: unrelatedData },
    });

    expect(projected).toEqual({
      input_video: { data: "[binary omitted]", format: "mp4" },
      output_audio: {
        audio: [
          { data: "[binary omitted]", format: "mp3" },
          { nested: [{ blob: "[binary omitted]" }] },
        ],
      },
      image_url: [{ data: "[binary omitted]", mime_type: "image/png" }],
      metadata: { data: unrelatedData },
    });
    const serialized = JSON.stringify(projected);
    for (const payload of [inputVideo, outputAudio, nestedAudio, inputImage]) {
      expect(serialized).not.toContain(payload);
    }
  });

  it("omits scalar media aliases while retaining unrelated scalar text", () => {
    const inputVideo = Buffer.from("private-scalar-input-video").toString("base64");
    const image = Buffer.from("private-scalar-image").toString("base64");
    const outputAudio = Buffer.from("private-scalar-output-audio").toString("base64");

    const projected = projectMcpJsonValue({
      input_video: inputVideo,
      nested: { image },
      output_audio: [outputAudio, { audio: outputAudio }],
      input_video_label: "keep this label",
      description: "ordinary text",
    });

    expect(projected).toEqual({
      input_video: "[binary omitted]",
      nested: { image: "[binary omitted]" },
      output_audio: ["[binary omitted]", { audio: "[binary omitted]" }],
      input_video_label: "keep this label",
      description: "ordinary text",
    });
    const serialized = JSON.stringify(projected);
    for (const payload of [inputVideo, image, outputAudio]) {
      expect(serialized).not.toContain(payload);
    }
  });
});
