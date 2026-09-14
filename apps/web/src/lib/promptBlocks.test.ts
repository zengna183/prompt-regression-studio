import { describe, expect, it } from "vitest";

import {
  createPromptBlock,
  createStableBlockId,
  movePromptBlock,
  patchPromptBlock,
} from "./promptBlocks";

describe("Prompt 区块标识", () => {
  it("编辑内容时保留稳定 ID", () => {
    const original = createPromptBlock("role", [], () => "12345678-1234-4567-8901-123456789012");
    const [edited] = patchPromptBlock([original], original.id, {
      name: "新的角色名称",
      content: "你是一名严谨的客服助手。",
    });

    expect(edited?.id).toBe(original.id);
    expect(edited?.content).toBe("你是一名严谨的客服助手。");
  });

  it("遇到相同随机片段时仍生成唯一 ID", () => {
    const uuid = () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const first = createStableBlockId("policy", new Set(), uuid);
    const second = createStableBlockId("policy", new Set([first]), uuid);

    expect(first).toBe("policy_aaaaaaaaaaaa");
    expect(second).toBe("policy_aaaaaaaaaaaa_2");
  });

  it("调整顺序时不改变任何区块 ID", () => {
    const first = createPromptBlock("role", [], () => "11111111-1111-1111-1111-111111111111");
    const second = createPromptBlock(
      "policy",
      [first],
      () => "22222222-2222-2222-2222-222222222222",
    );

    expect(movePromptBlock([first, second], 1, -1).map((block) => block.id)).toEqual([
      second.id,
      first.id,
    ]);
  });
});
