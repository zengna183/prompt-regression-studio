import { describe, expect, it } from "vitest";

import { revertPromptBlock } from "./ablation.js";
import type { PromptBlock } from "./schema.js";

const block = (id: string, content = id): PromptBlock => ({
  id,
  kind: "policy",
  name: id,
  content,
});

describe("single-block interventions", () => {
  it("reverts exactly one rewrite and does not mutate either input", () => {
    const before = [block("a", "old"), block("b", "old b")];
    const after = [block("a", "new"), block("b", "new b")];
    const result = revertPromptBlock(before, after, "a");
    expect(result).toEqual([block("a", "old"), block("b", "new b")]);
    expect(after[0]?.content).toBe("new");
    expect(result[0]).not.toBe(before[0]);
  });
  it("removes a candidate-only addition", () => {
    expect(revertPromptBlock([block("a")], [block("a"), block("b")], "b")).toEqual([block("a")]);
  });
  it("restores a deleted block before the next surviving baseline block", () => {
    expect(
      revertPromptBlock(
        [block("a"), block("b"), block("c")],
        [block("a"), block("x"), block("c")],
        "b",
      ),
    ).toEqual([block("a"), block("x"), block("b"), block("c")]);
  });
  it("restores a deleted trailing block", () => {
    expect(revertPromptBlock([block("a"), block("b")], [block("a")], "b")).toEqual([
      block("a"),
      block("b"),
    ]);
  });
  it("rejects absent, unchanged and reordered blocks", () => {
    expect(() => revertPromptBlock([block("a")], [block("a")], "unknown")).toThrow(
      "does not exist",
    );
    expect(() => revertPromptBlock([block("a")], [block("a")], "a")).toThrow("has not changed");
    expect(() =>
      revertPromptBlock([block("a"), block("b")], [block("b"), block("a")], "a"),
    ).toThrow("reordering");
  });
  it("refuses to remove the last block and refuses duplicate block IDs", () => {
    expect(() => revertPromptBlock([block("a")], [block("b")], "b")).toThrow("at least one");
    expect(() => revertPromptBlock([block("a")], [block("a"), block("a")], "a")).toThrow(
      "Duplicate",
    );
  });
  it("refuses metadata-only changes that do not alter model input", () => {
    expect(() =>
      revertPromptBlock([block("a")], [{ ...block("a"), name: "new label" }], "a"),
    ).toThrow("does not change the compiled");
  });
});
