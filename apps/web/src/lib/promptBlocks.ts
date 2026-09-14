import type { PromptBlock } from "@ai-chat-eval/contracts";

export type PromptBlockKind = PromptBlock["kind"];

export const PROMPT_BLOCK_KINDS: ReadonlyArray<{
  value: PromptBlockKind;
  label: string;
  hint: string;
}> = [
  { value: "role", label: "角色", hint: "定义 AI 是谁、承担什么职责" },
  { value: "policy", label: "规则", hint: "约束必须做和不能做的事情" },
  { value: "context", label: "背景", hint: "提供回答需要使用的上下文" },
  { value: "examples", label: "示例", hint: "用输入输出示范期望表现" },
  { value: "output_format", label: "输出格式", hint: "规定最终回答的结构" },
  { value: "custom", label: "自定义", hint: "放置其他独立且可归因的内容" },
] as const;

export function createStableBlockId(
  kind: PromptBlockKind,
  existingIds: ReadonlySet<string>,
  uuidFactory: () => string = () => globalThis.crypto.randomUUID(),
): string {
  const token = uuidFactory().replaceAll("-", "").slice(0, 12).toLowerCase();
  const base = `${kind}_${token}`;
  let candidate = base;
  let suffix = 2;

  while (existingIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }

  return candidate;
}

export function createPromptBlock(
  kind: PromptBlockKind,
  existingBlocks: readonly PromptBlock[],
  uuidFactory?: () => string,
): PromptBlock {
  const definition = PROMPT_BLOCK_KINDS.find((item) => item.value === kind);
  const existingIds = new Set(existingBlocks.map((block) => block.id));

  return {
    id: createStableBlockId(kind, existingIds, uuidFactory),
    kind,
    name: definition?.label ?? "新块",
    content: "",
  };
}

export function patchPromptBlock(
  blocks: readonly PromptBlock[],
  blockId: string,
  patch: Partial<Omit<PromptBlock, "id">>,
): PromptBlock[] {
  return blocks.map((block) =>
    block.id === blockId ? { ...block, ...patch, id: block.id } : block,
  );
}

export function movePromptBlock(
  blocks: readonly PromptBlock[],
  index: number,
  direction: -1 | 1,
): PromptBlock[] {
  const targetIndex = index + direction;

  if (index < 0 || index >= blocks.length || targetIndex < 0 || targetIndex >= blocks.length) {
    return [...blocks];
  }

  const next = [...blocks];
  const current = next[index];
  const target = next[targetIndex];

  if (!current || !target) {
    return next;
  }

  next[index] = target;
  next[targetIndex] = current;
  return next;
}
