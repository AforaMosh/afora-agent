/** Covers plugin schema validation for manifests and exported config schemas. */
import { Format } from "typebox/format";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

const jsonSchemaThenKeyword = ["the", "n"].join("");
const automaticModeSchema = { type: "string", default: "auto" } as const;
const manualModeSchema = { type: "string", default: "manual" } as const;
const apiKindSchema = { const: "api" } as const;
const numberedVersions = Array.from({ length: 13 }, (_, index) => `v${index + 1}`);
const automaticModeObjectSchema = {
  type: "object",
  properties: { mode: automaticModeSchema },
} as const;
const enabledBooleanSchema = { type: "boolean", default: true } as const;
const defaultApiEndpointSchema = {
  type: "string",
  default: "https://example.com",
} as const;
const apiKindCondition = {
  properties: { kind: apiKindSchema },
  required: ["kind"],
} as const;
const requiredApiEndpointBranch = {
  properties: { endpoint: defaultApiEndpointSchema },
  required: ["endpoint"],
} as const;
const requiredUriSchema = {
  type: "object",
  properties: { apiRoot: { type: "string", format: "uri" } },
  required: ["apiRoot"],
} as const;

function expectValidationFailure(
  params: Parameters<typeof validateJsonSchemaValue>[0],
): Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }> {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected validation failure");
  }
  return result;
}

function expectValidationIssue(
  result: Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }>,
  path: string,
) {
  const issue = result.errors.find((entry) => entry.path === path);
  if (!issue) {
    expect(result.errors.map((entry) => entry.path)).toContain(path);
    throw new Error(`expected validation issue at ${path}`);
  }
  return issue;
}

function expectIssueMessageIncludes(
  issue: ReturnType<typeof expectValidationIssue>,
  fragments: readonly string[],
) {
  expect(issue.message).toContain(fragments[0] ?? "");
  fragments.slice(1).forEach((fragment) => {
    expect(issue.message).toContain(fragment);
  });
}

function expectSuccessfulValidationValue(params: {
  input: Parameters<typeof validateJsonSchemaValue>[0];
  expectedValue: unknown;
}) {
  const result = validateJsonSchemaValue(params.input);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toEqual(params.expectedValue);
  }
}

function expectStringSchemaValidation(
  cacheKey: string,
  schema: Parameters<typeof validateJsonSchemaValue>[0]["schema"],
) {
  expectSuccessfulValidationValue({
    input: { cacheKey, schema, value: "ok" },
    expectedValue: "ok",
  });
}

function expectDefaultedValidationValue(params: {
  cacheKey: string;
  schema: Parameters<typeof validateJsonSchemaValue>[0]["schema"];
  value?: unknown;
  expectedValue?: unknown;
}) {
  const { cacheKey, schema, value = {}, expectedValue = { mode: "auto" } } = params;
  expectSuccessfulValidationValue({
    input: { cacheKey, schema, value, applyDefaults: true },
    expectedValue,
  });
}

function expectValidationSuccess(params: Parameters<typeof validateJsonSchemaValue>[0]) {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(true);
}

function expectUriValidationCase(params: {
  input: Parameters<typeof validateJsonSchemaValue>[0];
  ok: boolean;
  expectedPath?: string;
  expectedMessage?: string;
}) {
  if (params.ok) {
    expectValidationSuccess(params.input);
    return;
  }

  const result = expectValidationFailure(params.input);
  const issue = expectValidationIssue(result, params.expectedPath ?? "");
  expect(issue.message).toContain(params.expectedMessage ?? "");
}

describe("schema validator", () => {
  it("can apply JSON Schema defaults while validating", () => {
    const value = {};
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.defaults.clone",
      schema: {
        ...automaticModeObjectSchema,
        additionalProperties: false,
      },
      value,
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ mode: "auto" });
      expect(result.value).not.toBe(value);
    }
    expect(value).toStrictEqual({});

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults",
      schema: {
        ...automaticModeObjectSchema,
        additionalProperties: false,
      },
    });
  });

  it("applies JSON Schema defaults through local refs and map entries", () => {
    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.refs",
      schema: {
        type: "object",
        properties: {
          settings: {
            $ref: "#/definitions/Settings",
          },
        },
        additionalProperties: {
          $ref: "#/definitions/Settings",
        },
        definitions: {
          Settings: {
            ...automaticModeObjectSchema,
            additionalProperties: false,
          },
        },
      },
      value: {
        settings: {},
        accountA: {},
      },
      expectedValue: {
        settings: { mode: "auto" },
        accountA: { mode: "auto" },
      },
    });
  });

  it("does not apply defaults from non-matching union branches", () => {
    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.union",
      schema: {
        oneOf: [
          {
            type: "object",
            properties: {
              type: { const: "a" },
              aDefault: { type: "string", default: "a" },
            },
            required: ["type"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: { const: "b" },
              bDefault: { type: "string", default: "b" },
            },
            required: ["type"],
            additionalProperties: false,
          },
        ],
      },
      value: { type: "a" },
      expectedValue: { type: "a" },
    });
  });

  it("accepts nullable JSON Schema type arrays", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.nullable-array",
        schema: {
          type: ["array", "null"],
          items: { type: "string" },
        },
        value: null,
      },
      expectedValue: null,
    });
  });

  it("accepts AJV-style nullable typed schemas", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.nullable-keyword",
        schema: {
          type: "string",
          nullable: true,
        },
        value: null,
      },
      expectedValue: null,
    });
  });

  it("keeps non-type constraints on nullable JSON Schema type arrays", () => {
    const result = expectValidationFailure({
      cacheKey: "schema-validator.test.nullable-enum",
      schema: {
        type: ["string", "null"],
        enum: ["on"],
      },
      value: null,
    });

    expectValidationIssue(result, "<root>");
  });

  it("rejects invalid JSON Schema type declarations", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.test.invalid-schema-type",
        schema: {
          type: "not-a-json-schema-type",
        },
        value: "anything",
      }),
    ).toThrow("invalid schema");
  });

  it("rejects invalid JSON Schema constraint keyword values", () => {
    const invalidSchemas = {
      required: { type: "object", properties: { url: { type: "string" } }, required: "url" },
      "min-length": { type: "string", minLength: "1" },
      "additional-properties": { type: "object", additionalProperties: [] },
      "empty-allof": { allOf: [] },
      "empty-anyof": { anyOf: [] },
      "empty-oneof": { oneOf: [] },
      "empty-enum": { enum: [] },
      "duplicate-enum": { enum: ["api", "api"] },
      "duplicate-required": { type: "object", required: ["mode", "mode"] },
      "duplicate-type-array": { type: ["string", "string"] },
      ref: { $ref: "#/$defs/Missing" },
      "array-ref-leading-zero": {
        anyOf: [{ type: "number" }, { type: "string" }],
        $ref: "#/anyOf/01",
      },
      "dynamic-ref-type": { $dynamicRef: 123 },
      "dynamic-ref": { $dynamicRef: "#/$defs/Missing" },
      "nullable-type": { type: "string", nullable: "yes" },
      "nullable-without-type": { nullable: true },
      "anchor-ref": {
        $defs: { Other: { $id: "other", $anchor: "value", type: "string" } },
        $ref: "#value",
      },
      "external-ref": { $ref: "https://example.com/missing" },
      "dependencies-value": { type: "object", dependencies: { mode: 123 } },
      "dependencies-array": { type: "object", dependencies: { mode: [1] } },
    };
    for (const [suffix, schema] of Object.entries(invalidSchemas)) {
      expect(() =>
        validateJsonSchemaValue({
          cacheKey: `schema-validator.test.invalid-${suffix}`,
          schema,
          value: "anything",
        }),
      ).toThrow("invalid schema");
    }
  });

  it("accepts valid local refs to boolean schemas and anchors", () => {
    const denied = expectValidationFailure({
      cacheKey: "schema-validator.test.false-ref",
      schema: {
        $defs: {
          Never: false,
        },
        $ref: "#/$defs/Never",
      },
      value: "anything",
    });
    expectValidationIssue(denied, "<root>");

    expectStringSchemaValidation("schema-validator.test.anchor-ref", {
      $defs: {
        Value: {
          $anchor: "value",
          type: "string",
        },
      },
      $ref: "#value",
    });

    expectStringSchemaValidation("schema-validator.test.nested-resource-anchor-ref", {
      $defs: {
        Other: {
          $id: "other",
          $defs: {
            Value: {
              $anchor: "value",
              type: "string",
            },
          },
          $ref: "#value",
        },
      },
      $ref: "#/$defs/Other",
    });

    expectStringSchemaValidation("schema-validator.test.absolute-same-document-ref", {
      $id: "https://example.com/schema",
      $defs: {
        Value: {
          type: "string",
        },
      },
      $ref: "https://example.com/schema#/$defs/Value",
    });

    expectStringSchemaValidation("schema-validator.test.embedded-absolute-id-ref", {
      $defs: {
        Value: {
          $id: "https://example.com/value",
          type: "string",
        },
      },
      $ref: "https://example.com/value",
    });

    expectStringSchemaValidation("schema-validator.test.embedded-relative-id-ref", {
      $defs: {
        Value: {
          $id: "value",
          type: "string",
        },
      },
      $ref: "value",
    });

    expectStringSchemaValidation("schema-validator.test.resolved-relative-id-ref", {
      $id: "https://example.com/root/",
      $defs: {
        Value: {
          $id: "value",
          type: "string",
        },
      },
      $ref: "https://example.com/root/value",
    });

    expectStringSchemaValidation("schema-validator.test.empty-id-local-ref", {
      $id: "",
      $defs: {
        Value: {
          type: "string",
        },
      },
      $ref: "#/$defs/Value",
    });

    expectStringSchemaValidation("schema-validator.test.dynamic-ref", {
      $defs: {
        Value: {
          $dynamicAnchor: "value",
          type: "string",
        },
      },
      $dynamicRef: "#value",
    });

    expectValidationFailure({
      cacheKey: "schema-validator.test.dynamic-ref",
      schema: {
        $defs: {
          Value: {
            $dynamicAnchor: "value",
            type: "string",
          },
        },
        $dynamicRef: "#value",
      },
      value: 1,
    });
  });

  it("accepts local refs into schema arrays", () => {
    expectStringSchemaValidation("schema-validator.test.array-ref", {
      anyOf: [{ type: "string" }],
      $ref: "#/anyOf/0",
    });
    expectStringSchemaValidation("schema-validator.test.tuple-ref", {
      items: [{ type: "string" }],
      $ref: "#/items/0",
    });
  });

  it("accepts percent-encoded local ref pointer segments", () => {
    expectStringSchemaValidation("schema-validator.test.percent-encoded-ref", {
      $defs: {
        "foo bar": {
          type: "string",
        },
      },
      $ref: "#/$defs/foo%20bar",
    });
  });

  it("accepts local refs to anchors inside dependency schemas", () => {
    const schema = {
      type: "object",
      dependencies: {
        a: {
          $defs: {
            Target: {
              $anchor: "target",
              type: "object",
            },
          },
        },
        b: {
          properties: {
            b: {
              $ref: "#target",
            },
          },
          required: ["b"],
        },
      },
    } as const;
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.dependencies-anchor-ref",
        schema,
        value: {
          a: {},
          b: {},
        },
      },
      expectedValue: {
        a: {},
        b: {},
      },
    });
    expectValidationFailure({
      cacheKey: "schema-validator.test.dependencies-anchor-ref",
      schema,
      value: {
        a: {},
        b: 1,
      },
    });
  });

  it("applies defaults through refs that target embedded schema resources", () => {
    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.embedded-resource-default-ref",
      schema: {
        $defs: {
          Other: {
            $id: "other",
            $defs: {
              Defaulted: {
                ...automaticModeObjectSchema,
              },
            },
            properties: {
              settings: {
                $ref: "#/$defs/Defaulted",
              },
            },
          },
        },
        $ref: "#/$defs/Other/properties/settings",
      },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.same-ref-text-nested-resource-default",
      schema: {
        $defs: {
          Settings: {
            $id: "settings",
            type: "object",
            $defs: {
              Settings: {
                type: "object",
                properties: {
                  mode: {
                    type: "string",
                    default: "nested",
                  },
                },
              },
            },
            properties: {
              child: {
                $ref: "#/$defs/Settings",
              },
            },
          },
        },
        $ref: "#/$defs/Settings",
      },
      value: {
        child: {},
      },
      expectedValue: {
        child: {
          mode: "nested",
        },
      },
    });

    for (const { cacheKey, resourceId, ref, rootId } of [
      {
        cacheKey: "absolute-id-default-ref",
        resourceId: "https://example.com/settings",
        ref: "https://example.com/settings",
      },
      { cacheKey: "relative-id-default-ref", resourceId: "settings", ref: "settings" },
      {
        cacheKey: "resolved-relative-id-default-ref",
        resourceId: "settings",
        ref: "https://example.com/root/settings",
        rootId: "https://example.com/root/",
      },
    ]) {
      expectDefaultedValidationValue({
        cacheKey: `schema-validator.test.${cacheKey}`,
        schema: {
          ...(rootId ? { $id: rootId } : {}),
          $defs: { Settings: { $id: resourceId, ...automaticModeObjectSchema } },
          $ref: ref,
        },
      });
    }

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.relative-resource-ref",
      schema: {
        $id: "https://example.com/root/",
        type: "object",
        properties: {
          settings: {
            $ref: "./settings",
          },
        },
        required: ["settings"],
        additionalProperties: false,
        $defs: {
          Settings: {
            $id: "settings",
            ...automaticModeObjectSchema,
            required: ["mode"],
            additionalProperties: false,
          },
        },
      },
      value: {
        settings: {},
      },
      expectedValue: {
        settings: {
          mode: "auto",
        },
      },
    });
  });

  it("accepts draft-07 tuple item schemas", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.tuple-items",
        schema: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
          additionalItems: false,
        },
        value: ["mode", 1],
      },
      expectedValue: ["mode", 1],
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.tuple-items",
      schema: {
        type: "array",
        items: [
          { type: "string", default: "mode" },
          { type: "number", default: 1 },
        ],
        minItems: 2,
        additionalItems: false,
      },
      value: [],
      expectedValue: ["mode", 1],
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.prefix-items",
      schema: {
        type: "array",
        prefixItems: [
          { type: "string", default: "mode" },
          { type: "number", default: 1 },
        ],
        minItems: 2,
      },
      value: [],
      expectedValue: ["mode", 1],
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.tuple-item-nested-default",
      schema: {
        type: "array",
        items: [
          {
            type: "object",
            default: {},
            properties: {
              mode: automaticModeSchema,
            },
            required: ["mode"],
          },
        ],
        minItems: 1,
      },
      value: [],
      expectedValue: [{ mode: "auto" }],
    });
  });

  it("applies defaults for untyped object schemas", () => {
    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.untyped-object",
      schema: {
        properties: {
          mode: automaticModeSchema,
        },
        additionalProperties: false,
      },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.untyped-pattern-properties",
      schema: {
        patternProperties: {
          "^x": {
            ...automaticModeObjectSchema,
          },
        },
      },
      value: { x1: {} },
      expectedValue: { x1: { mode: "auto" } },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.untyped-additional-properties",
      schema: {
        additionalProperties: {
          type: "object",
          properties: {
            mode: manualModeSchema,
          },
        },
      },
      value: { other: {} },
      expectedValue: { other: { mode: "manual" } },
    });
  });

  it("applies defaults through active dependency and conditional schemas", () => {
    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.dependencies",
      schema: {
        type: "object",
        properties: {
          flag: {
            type: "boolean",
          },
        },
        dependencies: {
          flag: {
            properties: {
              mode: automaticModeSchema,
            },
            required: ["mode"],
          },
        },
      },
      value: { flag: true },
      expectedValue: { flag: true, mode: "auto" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional",
      schema: {
        type: "object",
        properties: {
          kind: apiKindSchema,
        },
        if: apiKindCondition,
        [jsonSchemaThenKeyword]: requiredApiEndpointBranch,
      },
      value: { kind: "api" },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-ref",
      schema: {
        type: "object",
        $defs: {
          ApiKind: {
            properties: {
              kind: apiKindSchema,
            },
            required: ["kind"],
          },
        },
        if: {
          $ref: "#/$defs/ApiKind",
        },
        [jsonSchemaThenKeyword]: requiredApiEndpointBranch,
      },
      value: { kind: "api" },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-format-annotation",
      schema: {
        type: "object",
        properties: {
          contact: {
            type: "string",
          },
        },
        if: {
          properties: {
            contact: {
              type: "string",
              format: "email",
            },
          },
          required: ["contact"],
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: automaticModeSchema,
          },
          required: ["mode"],
        },
      },
      value: { contact: "not an email" },
      expectedValue: { contact: "not an email", mode: "auto" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-ref-resource-property-object",
      schema: {
        type: "object",
        properties: {
          kind: {
            properties: {
              value: apiKindSchema,
            },
            required: ["value"],
          },
        },
        if: {
          $ref: "#/properties/kind",
        },
        [jsonSchemaThenKeyword]: requiredApiEndpointBranch,
      },
      value: { value: "api" },
      expectedValue: { value: "api", endpoint: "https://example.com" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-nested-ref-resource-property",
      schema: {
        type: "object",
        properties: {
          kind: {
            properties: {
              value: apiKindSchema,
            },
            required: ["value"],
          },
        },
        if: {
          properties: {
            kind: {
              $ref: "#/properties/kind",
            },
          },
          required: ["kind"],
        },
        [jsonSchemaThenKeyword]: requiredApiEndpointBranch,
      },
      value: { kind: { value: "api" } },
      expectedValue: { kind: { value: "api" }, endpoint: "https://example.com" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-ref-with-local-defs",
      schema: {
        type: "object",
        $defs: {
          ApiKind: {
            properties: {
              kind: apiKindSchema,
            },
            required: ["kind"],
          },
        },
        if: {
          $defs: {
            Local: {
              type: "string",
            },
          },
          $ref: "#/$defs/ApiKind",
        },
        [jsonSchemaThenKeyword]: requiredApiEndpointBranch,
      },
      value: { kind: "api" },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-ref-root-defs-win",
      schema: {
        type: "object",
        $defs: {
          MatchKind: {
            properties: {
              kind: apiKindSchema,
            },
            required: ["kind"],
          },
        },
        if: {
          $defs: {
            MatchKind: {
              properties: {
                kind: {
                  const: "other",
                },
              },
              required: ["kind"],
            },
          },
          $ref: "#/$defs/MatchKind",
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            endpoint: defaultApiEndpointSchema,
          },
        },
      },
      value: { kind: "api" },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-activated-by-default",
      schema: {
        type: "object",
        properties: {
          kind: {
            const: "api",
            default: "api",
          },
        },
        if: apiKindCondition,
        [jsonSchemaThenKeyword]: requiredApiEndpointBranch,
      },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-default-selects-one-branch",
      schema: {
        type: "object",
        properties: {
          kind: {
            const: "api",
            default: "api",
          },
        },
        if: apiKindCondition,
        [jsonSchemaThenKeyword]: {
          properties: {
            endpoint: defaultApiEndpointSchema,
          },
        },
        else: {
          properties: {
            path: {
              type: "string",
              default: "/tmp",
            },
          },
        },
      },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-default-branch-flip",
      schema: {
        type: "object",
        if: {
          not: {
            required: ["mode"],
          },
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: automaticModeSchema,
          },
        },
        else: {
          properties: {
            explicit: enabledBooleanSchema,
          },
          required: ["explicit"],
        },
      },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-defaulted-condition-remains-valid",
      schema: {
        type: "object",
        properties: {
          flag: enabledBooleanSchema,
        },
        if: {
          properties: {
            flag: { const: true },
          },
          required: ["flag"],
        },
        [jsonSchemaThenKeyword]: {
          required: ["secret"],
        },
      },
      expectedValue: { flag: true },
    });

    const explicitConditionResult = expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-explicit-condition-still-fails",
      schema: {
        type: "object",
        properties: {
          flag: enabledBooleanSchema,
        },
        if: {
          properties: {
            flag: { const: true },
          },
          required: ["flag"],
        },
        [jsonSchemaThenKeyword]: {
          required: ["secret"],
        },
      },
      value: { flag: true },
      applyDefaults: true,
    });
    expectValidationIssue(explicitConditionResult, "<root>");

    expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-invalid-default",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
          },
        },
        if: {
          not: {
            required: ["mode"],
          },
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: {
              type: "number",
              default: 1,
            },
          },
        },
        else: {
          properties: {
            explicit: {
              type: "boolean",
            },
          },
          required: ["explicit"],
        },
      },
      value: {},
      applyDefaults: true,
    });

    expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-invalid-branch-default",
      schema: {
        type: "object",
        properties: {
          flag: enabledBooleanSchema,
        },
        if: {
          properties: {
            flag: { const: true },
          },
          required: ["flag"],
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: {
              type: "number",
              default: "bad",
            },
          },
        },
      },
      value: {},
      applyDefaults: true,
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-hydrates-parent-property",
      schema: {
        type: "object",
        properties: {
          kind: apiKindSchema,
          settings: {
            ...automaticModeObjectSchema,
            required: ["mode"],
          },
        },
        if: apiKindCondition,
        [jsonSchemaThenKeyword]: {
          properties: {
            settings: {
              type: "object",
              default: {},
            },
          },
          required: ["settings"],
        },
      },
      value: { kind: "api" },
      expectedValue: { kind: "api", settings: { mode: "auto" } },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.dependency-activated-by-default",
      schema: {
        type: "object",
        properties: {
          flag: enabledBooleanSchema,
        },
        dependencies: {
          flag: {
            properties: {
              mode: automaticModeSchema,
            },
            required: ["mode"],
          },
        },
      },
      expectedValue: { flag: true, mode: "auto" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.conditional-activates-dependency",
      schema: {
        type: "object",
        properties: {
          kind: apiKindSchema,
        },
        dependencies: {
          flag: {
            properties: {
              mode: automaticModeSchema,
            },
            required: ["mode"],
          },
        },
        if: apiKindCondition,
        [jsonSchemaThenKeyword]: {
          properties: {
            flag: enabledBooleanSchema,
          },
          required: ["flag"],
        },
      },
      value: { kind: "api" },
      expectedValue: { kind: "api", flag: true, mode: "auto" },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.reverse-dependency-chain",
      schema: {
        type: "object",
        properties: {
          a: enabledBooleanSchema,
        },
        dependencies: Object.fromEntries(
          [
            ["e", "f"],
            ["d", "e"],
            ["c", "d"],
            ["b", "c"],
            ["a", "b"],
          ].map(([property, dependency]) => [
            property,
            { properties: { [dependency]: enabledBooleanSchema }, required: [dependency] },
          ]),
        ),
      },
      expectedValue: { a: true, b: true, c: true, d: true, e: true, f: true },
    });

    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.dependency-activates-conditional",
      schema: {
        type: "object",
        properties: {
          a: enabledBooleanSchema,
        },
        dependencies: {
          b: {
            properties: {
              kind: {
                const: "api",
                default: "api",
              },
            },
            required: ["kind"],
          },
          a: {
            properties: {
              b: enabledBooleanSchema,
            },
            required: ["b"],
          },
        },
        if: apiKindCondition,
        [jsonSchemaThenKeyword]: requiredApiEndpointBranch,
      },
      expectedValue: { a: true, b: true, kind: "api", endpoint: "https://example.com" },
    });
  });

  it("applies defaults through patternProperties before additionalProperties", () => {
    expectDefaultedValidationValue({
      cacheKey: "schema-validator.test.defaults.pattern-properties",
      schema: {
        type: "object",
        patternProperties: {
          "^x": {
            ...automaticModeObjectSchema,
            additionalProperties: false,
          },
        },
        additionalProperties: {
          type: "object",
          properties: {
            mode: manualModeSchema,
          },
          additionalProperties: false,
        },
      },
      value: {
        other: {},
        x1: {},
      },
      expectedValue: {
        other: { mode: "manual" },
        x1: { mode: "auto" },
      },
    });
  });

  it("does not clone values when default application has no defaults to inject", () => {
    const value = { mode: "manual" };
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.defaults.no-clone",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
          },
        },
        additionalProperties: false,
      },
      value,
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(value);
    }
  });

  it("recompiles when a stable cache key receives a different schema shape", () => {
    const cacheKey = "schema-validator.test.cache-key-drift";
    expectValidationSuccess({
      cacheKey,
      schema: { type: "string" },
      value: "ok",
    });

    const result = expectValidationFailure({
      cacheKey,
      schema: { type: "number" },
      value: "not-a-number",
    });
    expectValidationIssue(result, "<root>");
  });

  it("can isolate caller schemas that reuse the same $id with different shapes", () => {
    const first = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.same-id.uncached",
      schema: {
        $id: "https://example.test/shared-schema",
        type: "object",
        properties: { foo: { type: "string" } },
        required: ["foo"],
        additionalProperties: false,
      },
      value: { foo: "ok" },
      cache: false,
    });
    expect(first.ok).toBe(true);

    const second = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.same-id.uncached",
      schema: {
        $id: "https://example.test/shared-schema",
        type: "object",
        properties: { bar: { type: "number" } },
        required: ["bar"],
        additionalProperties: false,
      },
      value: { bar: 1 },
      cache: false,
    });
    expect(second.ok).toBe(true);
  });

  it.each([
    {
      title: "includes allowed values in enum validation errors",
      params: {
        cacheKey: "schema-validator.test.enum",
        schema: {
          type: "object",
          properties: {
            fileFormat: {
              type: "string",
              enum: ["markdown", "html", "json"],
            },
          },
          required: ["fileFormat"],
        },
        value: { fileFormat: "txt" },
      },
      path: "fileFormat",
      messageIncludes: ["(allowed:"],
      allowedValues: ["markdown", "html", "json"],
      hiddenCount: 0,
    },
    {
      title: "includes allowed value in const validation errors",
      params: {
        cacheKey: "schema-validator.test.const",
        schema: {
          type: "object",
          properties: {
            mode: {
              const: "strict",
            },
          },
          required: ["mode"],
        },
        value: { mode: "relaxed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:"],
      allowedValues: ["strict"],
      hiddenCount: 0,
    },
    {
      title: "truncates long allowed-value hints",
      params: {
        cacheKey: "schema-validator.test.enum.truncate",
        schema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: numberedVersions,
            },
          },
          required: ["mode"],
        },
        value: { mode: "not-listed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:", "... (+1 more)"],
      allowedValues: numberedVersions.slice(0, 12),
      hiddenCount: 1,
    },
    {
      title: "truncates oversized allowed value entries",
      params: {
        cacheKey: "schema-validator.test.enum.long-value",
        schema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["a".repeat(300)],
            },
          },
          required: ["mode"],
        },
        value: { mode: "not-listed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:", "... (+"],
    },
  ])("$title", ({ params, path, messageIncludes, allowedValues, hiddenCount }) => {
    const result = expectValidationFailure(params);
    const issue = expectValidationIssue(result, path);

    expectIssueMessageIncludes(issue, messageIncludes);
    if (allowedValues) {
      expect(issue?.allowedValues).toEqual(allowedValues);
      expect(issue?.allowedValuesHiddenCount).toBe(hiddenCount);
    }
  });

  it.each([
    {
      title: "appends missing required property to the structured path",
      params: {
        cacheKey: "schema-validator.test.required.path",
        schema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              properties: {
                mode: { type: "string" },
              },
              required: ["mode"],
            },
          },
          required: ["settings"],
        },
        value: { settings: {} },
      },
      expectedPath: "settings.mode",
    },
    {
      title: "appends missing dependency property to the structured path",
      params: {
        cacheKey: "schema-validator.test.dependencies.path",
        schema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              dependencies: {
                mode: ["format"],
              },
            },
          },
        },
        value: { settings: { mode: "strict" } },
      },
      expectedPath: "settings.format",
    },
  ])("$title", ({ params, expectedPath }) => {
    const result = expectValidationFailure(params);
    const issue = expectValidationIssue(result, expectedPath);

    expect(issue?.allowedValues).toBeUndefined();
  });

  it("sanitizes terminal text while preserving structured fields", () => {
    const maliciousProperty = "evil\nkey\t\x1b[31mred\x1b[0m";
    const result = expectValidationFailure({
      cacheKey: "schema-validator.test.terminal-sanitize",
      schema: {
        type: "object",
        properties: {},
        required: [maliciousProperty],
      },
      value: {},
    });

    const issue = result.errors[0];
    if (!issue) {
      throw new Error("expected terminal sanitization validation issue");
    }
    expect(issue.path).toContain("\n");
    expect(issue.message).toContain("\n");
    expect(issue.text).toContain("\\n");
    expect(issue.text).toContain("\\t");
    expect(issue.text).not.toContain("\n");
    expect(issue.text).not.toContain("\t");
    expect(issue.text).not.toContain("\x1b");
  });

  it.each([
    {
      title: "accepts uri-formatted string schemas for valid urls",
      cacheKey: "schema-validator.test.uri.valid",
      apiRoot: "https://api.telegram.org",
      ok: true,
    },
    {
      title: "rejects uri-formatted string schemas for invalid urls",
      cacheKey: "schema-validator.test.uri.invalid",
      apiRoot: "not a uri",
      ok: false,
      expectedPath: "apiRoot",
      expectedMessage: "must match format",
    },
    {
      title: "rejects uri-formatted string schemas for invalid absolute urls",
      cacheKey: "schema-validator.test.uri.invalid-absolute",
      apiRoot: "https://",
      ok: false,
      expectedPath: "apiRoot",
      expectedMessage: "must match format",
    },
  ])(
    "supports uri-formatted string schemas: $title",
    ({ cacheKey, apiRoot, ok, expectedPath, expectedMessage }) => {
      expectUriValidationCase({
        input: { cacheKey, schema: requiredUriSchema, value: { apiRoot } },
        ok,
        expectedPath,
        expectedMessage,
      });
    },
  );

  it("treats non-uri string formats as annotations", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.format.email.annotation",
        schema: {
          type: "object",
          properties: {
            contact: {
              type: "string",
              format: "email",
            },
            token: {
              type: "string",
              format: "uuid",
            },
          },
          required: ["contact", "token"],
        },
        value: {
          contact: "not an email",
          token: "not a uuid",
        },
      },
      expectedValue: {
        contact: "not an email",
        token: "not a uuid",
      },
    });
  });

  it("does not weaken the global TypeBox format registry", () => {
    expect(Format.Get("email")?.("not an email")).toBe(false);
    expect(Format.Get("uuid")?.("not a uuid")).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
