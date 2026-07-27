// Gemini schema cleaner tests cover the OpenAPI-compatible provider boundary.
import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

type SchemaRecord = Record<string, unknown>;

describe("cleanSchemaForGemini", () => {
  it.each([
    { name: "coerces null properties to an empty object", properties: null },
    { name: "coerces non-object properties to an empty object", properties: "invalid" },
    { name: "coerces array properties to an empty object", properties: [] },
  ])("$name", ({ properties }) => {
    const cleaned = cleanSchemaForGemini({ type: "object", properties }) as SchemaRecord;
    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toStrictEqual({});
  });

  const requiredCases: Array<{
    name: string;
    schema: SchemaRecord;
    expected: string[] | undefined;
  }> = [
    {
      name: "filters required fields that are not in properties",
      schema: {
        type: "object",
        properties: { action: { type: "string" }, amount: { type: "number" } },
        required: ["action", "amount", "token"],
      },
      expected: ["action", "amount"],
    },
    {
      name: "preserves required when all fields exist in properties",
      schema: {
        type: "object",
        properties: { action: { type: "string" }, amount: { type: "number" } },
        required: ["action", "amount"],
      },
      expected: ["action", "amount"],
    },
    {
      name: "removes required entirely when no fields match properties",
      schema: {
        type: "object",
        properties: { action: { type: "string" } },
        required: ["missing_a", "missing_b"],
      },
      expected: undefined,
    },
    {
      name: "removes required from object schemas when properties is absent",
      schema: { type: "object", required: ["a", "b"] },
      expected: undefined,
    },
    {
      name: "leaves required as-is for non-object schemas when properties is absent",
      schema: { type: "array", required: ["a", "b"] },
      expected: ["a", "b"],
    },
    {
      name: "does not treat inherited keys as declared properties",
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["toString", "name"],
      },
      expected: ["name"],
    },
    {
      name: "strips empty required arrays",
      schema: { type: "object", properties: { name: { type: "string" } }, required: [] },
      expected: undefined,
    },
    {
      name: "preserves non-empty required arrays",
      schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      expected: ["name"],
    },
  ];

  it.each(requiredCases)("$name", ({ schema, expected }) => {
    const cleaned = cleanSchemaForGemini(schema) as { type?: unknown; required?: string[] };
    expect(cleaned.required).toEqual(expected);
    expect(cleaned.type).toBe(schema.type);
    if (expected === undefined) {
      expect(cleaned).not.toHaveProperty("required");
    }
  });

  it("filters required in nested object properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name", "ghost"],
        },
      },
    });
    expect(cleaned).toMatchObject({ properties: { config: { required: ["name"] } } });
  });

  it("coerces nested null properties while preserving valid siblings", () => {
    expect(
      cleanSchemaForGemini({
        type: "object",
        properties: {
          bad: { type: "object", properties: null },
          good: { type: "string" },
        },
      }),
    ).toMatchObject({ properties: { bad: { properties: {} }, good: { type: "string" } } });
  });

  it("strips empty required arrays in nested schemas", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { optional: { type: "string" } },
          required: [],
        },
      },
      required: ["nested"],
    }) as { properties?: { nested?: SchemaRecord }; required?: string[] };
    expect(cleaned.required).toEqual(["nested"]);
    expect(cleaned.properties?.nested).not.toHaveProperty("required");
  });

  it("strips the not keyword from schemas", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      not: { const: true },
      properties: { name: { type: "string" } },
    }) as SchemaRecord;
    expect(cleaned).not.toHaveProperty("not");
    expect(cleaned).toMatchObject({ type: "object", properties: { name: { type: "string" } } });
  });

  it("collapses type arrays by stripping null entries", () => {
    expect(
      cleanSchemaForGemini({ type: ["string", "null"], description: "nullable field" }),
    ).toMatchObject({ type: "string", description: "nullable field" });
  });

  it("collapses type arrays in nested property schemas", () => {
    expect(
      cleanSchemaForGemini({
        type: "object",
        properties: { agentId: { type: ["string", "null"], description: "Agent id" } },
      }),
    ).toMatchObject({ properties: { agentId: { type: "string" } } });
  });

  it.each([
    {
      name: "integer enum",
      schema: { type: "integer", enum: [1, 2, 3] },
      expected: { type: "integer", enum: ["1", "2", "3"] },
    },
    {
      name: "integer enum before type",
      schema: { enum: [1, 2, 3], type: "integer" },
      expected: { enum: ["1", "2", "3"], type: "integer" },
    },
    {
      name: "boolean enum",
      schema: { type: "boolean", enum: [true, false] },
      expected: { type: "boolean", enum: ["true", "false"] },
    },
    {
      name: "string enum",
      schema: { type: "string", enum: ["a", "b", "c"] },
      expected: { type: "string", enum: ["a", "b", "c"] },
    },
    {
      name: "integer const before type",
      schema: { const: 42, type: "integer" },
      expected: { enum: ["42"], type: "integer" },
    },
  ])("stringifies $name values without changing the schema type", ({ schema, expected }) => {
    expect(cleanSchemaForGemini(schema)).toStrictEqual(expected);
  });

  it("drops null/undefined enum entries and de-duplicates", () => {
    expect(
      cleanSchemaForGemini({ type: "integer", enum: [1, 2, 2, null, undefined, 3] }),
    ).toMatchObject({
      enum: ["1", "2", "3"],
    });
  });

  it("stringifies nested numeric enums while preserving their number type", () => {
    expect(
      cleanSchemaForGemini({
        type: "object",
        properties: {
          outer: {
            type: "array",
            items: {
              type: "object",
              properties: { score: { type: "number", enum: [1, 2, 3, 4, 5] } },
            },
          },
        },
      }),
    ).toMatchObject({
      properties: {
        outer: {
          items: { properties: { score: { type: "number", enum: ["1", "2", "3", "4", "5"] } } },
        },
      },
    });
  });

  it("returns no enum key when array becomes empty after coercion", () => {
    expect(
      cleanSchemaForGemini({ type: "integer", enum: [null, undefined, {}] }),
    ).not.toHaveProperty("enum");
  });
});
