import { describe, it, expect } from "vitest";
import { markdownToIR } from "./ir.js";

describe("Nested Lists - 2 Level Nesting", () => {
  it("records parser-owned item spans and list ancestry", () => {
    const result = markdownToIR("- parent\n  - child\n- next\n# Heading");
    const items = [...(result.listItems ?? [])].toSorted(
      (left, right) => (left.listMarker?.start ?? 0) - (right.listMarker?.start ?? 0),
    );
    const [parent, child, next] = items;
    expect(items).toHaveLength(3);
    expect(parent).toMatchObject({ depth: 0, start: 0 });
    expect(child).toMatchObject({ depth: 1, parentListId: parent?.listId });
    expect(next?.listId).toBe(parent?.listId);
    expect(result.text.slice(parent?.start, parent?.end)).toContain("child");
    expect(result.text.slice(next?.start, next?.end)).not.toContain("Heading");
  });

  it("keeps loose continuation paragraphs inside the item span", () => {
    const result = markdownToIR("- first\n\n  continuation\n- next");
    const first = result.listItems?.find((item) => item.listMarker?.start === 0);
    expect(result.text.slice(first?.start, first?.end)).toContain("continuation");
  });

  it.each([
    {
      name: "renders bullet items nested inside bullet items with proper indentation",
      input: "- Item 1\n  - Nested 1.1\n  - Nested 1.2\n- Item 2",
      expected: "• Item 1\n  • Nested 1.1\n  • Nested 1.2\n• Item 2",
    },
    {
      name: "renders ordered items nested inside bullet items",
      input: "- Bullet item\n  1. Ordered sub-item 1\n  2. Ordered sub-item 2\n- Another bullet",
      expected: "• Bullet item\n  1. Ordered sub-item 1\n  2. Ordered sub-item 2\n• Another bullet",
    },
    {
      name: "renders bullet items nested inside ordered items",
      input: "1. Ordered 1\n   - Bullet sub 1\n   - Bullet sub 2\n2. Ordered 2",
      expected: "1. Ordered 1\n  • Bullet sub 1\n  • Bullet sub 2\n2. Ordered 2",
    },
    {
      name: "renders ordered items nested inside ordered items",
      input: "1. First\n   1. Sub-first\n   2. Sub-second\n2. Second",
      expected: "1. First\n  1. Sub-first\n  2. Sub-second\n2. Second",
    },
  ])("$name", ({ input, expected }) => {
    expect(markdownToIR(input).text).toBe(expected);
  });
});

describe("Nested Lists - 3+ Level Deep Nesting", () => {
  it.each([
    {
      name: "renders 3 levels of bullet nesting",
      input: "- Level 1\n  - Level 2\n    - Level 3\n- Back to 1",
      expected: "• Level 1\n  • Level 2\n    • Level 3\n• Back to 1",
    },
    {
      name: "renders 4 levels of bullet nesting",
      input: "- L1\n  - L2\n    - L3\n      - L4\n- Back",
      expected: "• L1\n  • L2\n    • L3\n      • L4\n• Back",
    },
    {
      name: "renders 3 levels with multiple items at each level",
      input: "- A1\n  - B1\n    - C1\n    - C2\n  - B2\n- A2",
      expected: "• A1\n  • B1\n    • C1\n    • C2\n  • B2\n• A2",
    },
  ])("$name", ({ input, expected }) => {
    expect(markdownToIR(input).text).toBe(expected);
  });
});

describe("Nested Lists - Mixed Nesting", () => {
  it.each([
    {
      name: "renders complex mixed nesting (bullet > ordered > bullet)",
      input: "- Bullet 1\n  1. Ordered 1.1\n     - Deep bullet\n  2. Ordered 1.2\n- Bullet 2",
      expected: "• Bullet 1\n  1. Ordered 1.1\n    • Deep bullet\n  2. Ordered 1.2\n• Bullet 2",
    },
    {
      name: "renders ordered > bullet > ordered nesting",
      input: "1. First\n   - Sub bullet\n     1. Deep ordered\n   - Another bullet\n2. Second",
      expected: "1. First\n  • Sub bullet\n    1. Deep ordered\n  • Another bullet\n2. Second",
    },
  ])("$name", ({ input, expected }) => {
    expect(markdownToIR(input).text).toBe(expected);
  });
});

describe("Nested Lists - Newline Handling", () => {
  it("does not produce triple newlines in nested lists", () => {
    const input = `- Item 1
  - Nested
- Item 2`;

    const result = markdownToIR(input);
    expect(result.text).not.toContain("\n\n\n");
  });

  it("does not produce double newlines between nested items", () => {
    const input = `- A
  - B
  - C
- D`;

    const result = markdownToIR(input);

    // Between B and C there should be exactly one newline
    expect(result.text).toContain("  • B\n  • C");
    expect(result.text).not.toContain("  • B\n\n  • C");
  });

  it("properly terminates top-level list (trimmed output)", () => {
    const input = `- Item 1
  - Nested
- Item 2`;

    const result = markdownToIR(input);

    // markdownToIR trims trailing whitespace, so output should end with Item 2
    // (no trailing newline after trimming)
    expect(result.text).toMatch(/Item 2$/);
    // Should not have excessive newlines before Item 2
    expect(result.text).not.toContain("\n\n• Item 2");
  });
});

describe("Nested Lists - Edge Cases", () => {
  it("handles empty parent with nested items", () => {
    // This is a bit of an edge case - a list item that's just a marker followed by nested content
    const input = `-
  - Nested only
- Normal`;

    const result = markdownToIR(input);

    // Should still render the nested item with proper indentation
    expect(result.text).toContain("  • Nested only");
  });

  it("handles nested list as first child of parent item", () => {
    const input = `- Parent text
  - Child
- Another parent`;

    const result = markdownToIR(input);

    // The child should appear indented under the parent
    expect(result.text).toContain("• Parent text\n  • Child");
  });

  it("handles sibling nested lists at same level", () => {
    const input = `- A
  - A1
- B
  - B1`;

    const result = markdownToIR(input);

    const expected = `• A
  • A1
• B
  • B1`;

    expect(result.text).toBe(expected);
  });
});

describe("list paragraph spacing", () => {
  it.each([
    {
      name: "preserves paragraph breaks inside loose bullet list items",
      input: "- first paragraph\n\n  second paragraph\n- next",
      expected: "• first paragraph\n\nsecond paragraph\n\n• next",
    },
    {
      name: "preserves paragraph breaks inside loose ordered list items",
      input: "1. first paragraph\n\n   second paragraph\n2. next",
      expected: "1. first paragraph\n\nsecond paragraph\n\n2. next",
    },
    {
      name: "preserves paragraph breaks inside loose blockquoted list items",
      input: "> - first paragraph\n>\n>   second paragraph\n> - next",
      expected: "• first paragraph\n\nsecond paragraph\n\n• next",
    },
    {
      name: "does not add triple newlines before loose nested bullet lists",
      input: "- parent\n\n  - child\n\n- next",
      expected: "• parent\n\n  • child\n• next",
    },
    {
      name: "does not add triple newlines before loose nested ordered lists",
      input: "1. parent\n\n   1. child\n\n2. next",
      expected: "1. parent\n\n  1. child\n2. next",
    },
    {
      name: "keeps tight heading list items single-spaced",
      input: "- # A\n- # B",
      expected: "• A\n• B",
    },
    {
      name: "keeps tight blockquote list items single-spaced",
      input: "- > quote\n- next",
      expected: "• quote\n• next",
    },
  ])("$name", ({ input, expected }) => {
    const text = markdownToIR(input).text;
    expect(text).toBe(expected);
    expect(text).not.toContain("\n\n\n");
  });

  it("adds blank line between bullet list and following paragraph", () => {
    const input = `- item 1
- item 2

Paragraph after`;
    const result = markdownToIR(input);
    // Should have two newlines between "item 2" and "Paragraph"
    expect(result.text).toContain("item 2\n\nParagraph");
  });

  it("adds blank line between ordered list and following paragraph", () => {
    const input = `1. item 1
2. item 2

Paragraph after`;
    const result = markdownToIR(input);
    expect(result.text).toContain("item 2\n\nParagraph");
  });

  it("does not produce triple newlines", () => {
    const input = `- item 1
- item 2

Paragraph after`;
    const result = markdownToIR(input);
    // Should NOT have three consecutive newlines
    expect(result.text).not.toContain("\n\n\n");
  });
});
