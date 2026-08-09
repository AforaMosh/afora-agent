import { describe, expect, it } from "vitest";
import {
  normalizeMediaFactIdentities,
  normalizeMediaFacts,
  resolveMediaFactIdentityIndexes,
} from "./media-facts.js";

const facts = normalizeMediaFacts([
  { sourceId: "duplicate-id", sourceIndex: 5 },
  { sourceId: "duplicate-id", sourceIndex: 6 },
  { sourceId: "other-id", sourceIndex: 5 },
  { sourceId: "unique-id", sourceIndex: 10 },
  { sourceId: "fallback-index" },
  { sourceIndex: 11 },
  { sourceId: "duplicate-pair", sourceIndex: 13 },
  { sourceId: "duplicate-pair", sourceIndex: 13 },
]);

describe("resolveMediaFactIdentityIndexes", () => {
  it.each([
    {
      name: "exact pair with independently duplicated fields",
      identities: [{ sourceId: "duplicate-id", sourceIndex: 5 }],
      expected: [0],
    },
    {
      name: "unmatched cross pair",
      identities: [{ sourceId: "other-id", sourceIndex: 6 }],
      expected: [],
    },
    { name: "unique ID only", identities: [{ sourceId: "unique-id" }], expected: [3] },
    { name: "ambiguous ID only", identities: [{ sourceId: "duplicate-id" }], expected: [] },
    { name: "unique explicit index only", identities: [{ sourceIndex: 11 }], expected: [5] },
    { name: "unique effective fallback index", identities: [{ sourceIndex: 4 }], expected: [4] },
    { name: "ambiguous index only", identities: [{ sourceIndex: 5 }], expected: [] },
    {
      name: "ambiguous duplicate exact pair",
      identities: [{ sourceId: "duplicate-pair", sourceIndex: 13 }],
      expected: [],
    },
    { name: "unmatched identity", identities: [{ sourceId: "absent" }], expected: [] },
  ])("resolves $name", ({ identities, expected }) => {
    expect(resolveMediaFactIdentityIndexes(facts, identities)).toEqual(expected);
  });

  it("dedupes markers into canonical fact order", () => {
    expect(
      resolveMediaFactIdentityIndexes(facts, [
        { sourceIndex: 11 },
        { sourceId: "duplicate-id", sourceIndex: 5 },
        { sourceId: "fallback-index" },
        { sourceIndex: 11 },
      ]),
    ).toEqual([0, 4, 5]);
  });
});

describe("normalizeMediaFactIdentities", () => {
  it("preserves valid pair, ID-only, and index-only identities while rejecting malformed input", () => {
    expect(
      normalizeMediaFactIdentities([
        { sourceId: " paired ", sourceIndex: 2 },
        { sourceId: "id-only" },
        { sourceIndex: 3 },
        { sourceId: "must-stay-paired", sourceIndex: -1 },
        { sourceId: "  ", sourceIndex: 4 },
        {},
        { sourceId: "  " },
        { sourceIndex: -1 },
        { sourceIndex: 1.5 },
        null,
      ]),
    ).toEqual([
      { sourceId: "paired", sourceIndex: 2 },
      { sourceId: "id-only" },
      { sourceIndex: 3 },
    ]);
  });
});
