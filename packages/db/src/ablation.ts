import type { PromptBlock } from "./schema.js";
import { compilePrompt, normalizePromptBlocks, stableStringify } from "./versioning.js";

/** One intervention only; unrelated candidate blocks retain their content and order. */
export function revertPromptBlock(
  baseline: readonly PromptBlock[],
  candidate: readonly PromptBlock[],
  blockId: string,
): PromptBlock[] {
  const before = normalizePromptBlocks(baseline);
  const after = normalizePromptBlocks(candidate);
  const oldBlock = before.find((block) => block.id === blockId);
  const newBlock = after.find((block) => block.id === blockId);
  if (!oldBlock && !newBlock) throw new TypeError("The selected block does not exist.");
  // Restoring a move can change several positional effects; not a single-block rewrite.
  const commonIds = new Set(
    before.filter((block) => after.some((b) => b.id === block.id)).map((b) => b.id),
  );
  if (
    stableStringify(before.filter((b) => commonIds.has(b.id)).map((b) => b.id)) !==
    stableStringify(after.filter((b) => commonIds.has(b.id)).map((b) => b.id))
  ) {
    throw new TypeError("Block reordering requires a separate joint intervention.");
  }
  if (oldBlock && newBlock && stableStringify(oldBlock) === stableStringify(newBlock)) {
    throw new TypeError("The selected block has not changed.");
  }
  let result = after.map((block) => ({ ...block }));
  if (!oldBlock) {
    result = result.filter((block) => block.id !== blockId);
  } else if (newBlock) {
    result = result.map((block) => (block.id === blockId ? { ...oldBlock } : block));
  } else {
    // Insert before the next surviving baseline block, without moving candidate additions.
    const next = before
      .slice(before.findIndex((b) => b.id === blockId) + 1)
      .find((b) => after.some((item) => item.id === b.id));
    const index = next ? result.findIndex((b) => b.id === next.id) : result.length;
    result.splice(index, 0, { ...oldBlock });
  }
  const normalized = normalizePromptBlocks(result);
  if (compilePrompt(normalized).content === compilePrompt(after).content) {
    throw new TypeError("The intervention does not change the compiled Prompt text.");
  }
  return normalized;
}
