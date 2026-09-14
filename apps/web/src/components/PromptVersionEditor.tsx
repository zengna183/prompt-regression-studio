import { useMemo, useState, type FormEvent } from "react";
import type {
  CreatePromptVersion,
  Prompt,
  PromptBlock,
  PromptVersion,
} from "@ai-chat-eval/contracts";

import { getErrorMessage } from "../api/client";
import {
  PROMPT_BLOCK_KINDS,
  createPromptBlock,
  movePromptBlock,
  patchPromptBlock,
  type PromptBlockKind,
} from "../lib/promptBlocks";

interface PromptVersionEditorProps {
  prompt: Prompt;
  parentVersion: PromptVersion | null;
  onSubmit: (input: CreatePromptVersion) => Promise<void>;
  onCancel: () => void;
}

export function PromptVersionEditor({
  prompt,
  parentVersion,
  onSubmit,
  onCancel,
}: PromptVersionEditorProps) {
  const [blocks, setBlocks] = useState<PromptBlock[]>(() =>
    parentVersion
      ? parentVersion.blocks.map((block) => ({ ...block }))
      : [createPromptBlock("role", [])],
  );
  const [changeSummary, setChangeSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalCharacters = useMemo(
    () => blocks.reduce((sum, block) => sum + block.content.length, 0),
    [blocks],
  );

  function addBlock(kind: PromptBlockKind) {
    setBlocks((current) => [...current, createPromptBlock(kind, current)]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedBlocks = blocks.map((block) => ({
      ...block,
      name: block.name.trim(),
      content: block.content.trim(),
    }));

    if (normalizedBlocks.some((block) => !block.name || !block.content)) {
      setError("每个 Prompt 区块都需要填写名称和内容。");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        blocks: normalizedBlocks,
        ...(parentVersion ? { parentVersionId: parentVersion.id } : {}),
        ...(changeSummary.trim() ? { changeSummary: changeSummary.trim() } : {}),
      });
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="editor-shell" aria-labelledby="version-editor-title">
      <div className="editor-header">
        <div>
          <span className="eyebrow">VERSION DRAFT</span>
          <h2 id="version-editor-title">
            {parentVersion ? `基于 V${parentVersion.version} 创建新版本` : "创建第一个 Prompt 版本"}
          </h2>
          <p>
            {prompt.name} · 每个区块都有稳定
            ID，修改文字不会改变它，方便后续定位影响结果的具体段落。
          </p>
        </div>
        <button
          className="button button--quiet"
          type="button"
          onClick={onCancel}
          disabled={submitting}
        >
          返回版本列表
        </button>
      </div>

      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="editor-toolbar">
          <div>
            <strong>{blocks.length}</strong> 个区块
            <span aria-hidden="true">·</span>
            <strong>{totalCharacters}</strong> 个字符
          </div>
          <label className="add-block-control">
            <span className="sr-only">选择要添加的区块类型</span>
            <select
              value=""
              onChange={(event) => {
                if (event.target.value) {
                  addBlock(event.target.value as PromptBlockKind);
                  event.target.value = "";
                }
              }}
            >
              <option value="">＋ 添加区块</option>
              {PROMPT_BLOCK_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="block-list">
          {blocks.map((block, index) => {
            const kindInfo = PROMPT_BLOCK_KINDS.find((item) => item.value === block.kind);
            return (
              <fieldset className="prompt-block" key={block.id}>
                <legend className="sr-only">区块 {index + 1}</legend>
                <div className="prompt-block__rail" aria-hidden="true">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                </div>
                <div className="prompt-block__body">
                  <div className="prompt-block__header">
                    <div className="block-kind">
                      <select
                        aria-label={`区块 ${index + 1} 类型`}
                        value={block.kind}
                        onChange={(event) =>
                          setBlocks((current) =>
                            patchPromptBlock(current, block.id, {
                              kind: event.target.value as PromptBlockKind,
                            }),
                          )
                        }
                      >
                        {PROMPT_BLOCK_KINDS.map((kind) => (
                          <option key={kind.value} value={kind.value}>
                            {kind.label}
                          </option>
                        ))}
                      </select>
                      <span>{kindInfo?.hint}</span>
                    </div>
                    <div className="block-actions">
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => setBlocks((current) => movePromptBlock(current, index, -1))}
                        disabled={index === 0}
                        aria-label={`上移区块 ${index + 1}`}
                      >
                        ↑
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => setBlocks((current) => movePromptBlock(current, index, 1))}
                        disabled={index === blocks.length - 1}
                        aria-label={`下移区块 ${index + 1}`}
                      >
                        ↓
                      </button>
                      <button
                        className="icon-button icon-button--danger"
                        type="button"
                        onClick={() =>
                          setBlocks((current) => current.filter((item) => item.id !== block.id))
                        }
                        disabled={blocks.length === 1}
                        aria-label={`删除区块 ${index + 1}`}
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  <label>
                    <span>区块名称</span>
                    <input
                      value={block.name}
                      onChange={(event) =>
                        setBlocks((current) =>
                          patchPromptBlock(current, block.id, { name: event.target.value }),
                        )
                      }
                      maxLength={120}
                      required
                    />
                  </label>
                  <label>
                    <span>Prompt 内容</span>
                    <textarea
                      className="prompt-content"
                      value={block.content}
                      onChange={(event) =>
                        setBlocks((current) =>
                          patchPromptBlock(current, block.id, { content: event.target.value }),
                        )
                      }
                      rows={6}
                      maxLength={100000}
                      placeholder="填写这一段 Prompt 的完整内容……"
                      required
                    />
                  </label>
                  <div className="stable-id">
                    <span>稳定区块 ID</span>
                    <code>{block.id}</code>
                    <small>保存后不可改变，用于差异比较与归因。</small>
                  </div>
                </div>
              </fieldset>
            );
          })}
        </div>

        <div className="version-footer">
          <label>
            <span>本次修改说明（推荐填写）</span>
            <textarea
              value={changeSummary}
              onChange={(event) => setChangeSummary(event.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="例如：收紧拒答规则，并补充引用格式要求。"
            />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="version-footer__actions">
            <p>保存后生成草稿。草稿发布前不会用于正式实验。</p>
            <div className="form-actions">
              <button
                className="button button--quiet"
                type="button"
                onClick={onCancel}
                disabled={submitting}
              >
                取消
              </button>
              <button className="button button--primary" type="submit" disabled={submitting}>
                {submitting ? "正在保存…" : "保存为新草稿"}
              </button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
