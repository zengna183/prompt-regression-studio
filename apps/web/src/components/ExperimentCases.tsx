import { useCallback, useState } from "react";
import type { CaseScore, ExperimentCaseResult } from "@ai-chat-eval/contracts";
import { api } from "../api/client";
import { useResource } from "../lib/useResource";
import { ErrorState, LoadingState } from "./StatusViews";

const PAGE_SIZE = 5;
const text = (value: unknown) =>
  value === null || value === undefined
    ? "未提供"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
const percent = (value: number | null) =>
  value === null ? "暂无分数" : `${(value * 100).toFixed(1)}%`;

/** Mounted only on request, so inspecting evidence does not add a heavy polling request. */
export function ExperimentCases({
  projectId,
  experimentId,
  repetitions,
}: {
  projectId: string;
  experimentId: string;
  repetitions: number;
}) {
  const [offset, setOffset] = useState(0);
  const [repetition, setRepetition] = useState(1);
  const resource = useResource(
    useCallback(
      (signal: AbortSignal) =>
        api.listExperimentCases(
          projectId,
          experimentId,
          { offset, limit: PAGE_SIZE, repetition },
          signal,
        ),
      [projectId, experimentId, offset, repetition],
    ),
  );
  return (
    <section className="flow-card flow-stack case-evidence" aria-label="逐条用例证据">
      <h2>逐条核对回答与评分</h2>
      <p>
        每页最多 5
        条，只比较同一次重复评测。没有结果或评分不代表零分；评分理由是模型的判断依据，不代表已经证实根因。
      </p>
      <div className="flow-actions">
        <label>
          查看第几次评测
          <select
            value={repetition}
            onChange={(e) => {
              setRepetition(Number(e.target.value));
              setOffset(0);
            }}
          >
            {Array.from({ length: repetitions }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                第 {i + 1} 次
              </option>
            ))}
          </select>
        </label>
        <button
          className="button button--quiet"
          disabled={resource.loading}
          onClick={resource.reload}
        >
          刷新用例证据
        </button>
      </div>
      {resource.loading && <LoadingState label="正在读取本页证据" />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {resource.data && (
        <>
          <p role="status">
            共 {resource.data.total} 条用例，当前显示 {resource.data.items.length ? offset + 1 : 0}
            ～{offset + resource.data.items.length} 条
          </p>
          {resource.data.items.map((item) => (
            <details className="case-evidence__case" key={item.caseId}>
              <summary>{item.name || item.caseKey}</summary>
              <h3>用户输入</h3>
              <pre className="case-evidence__text">{text(item.input)}</pre>
              <h3>参考答案或判定依据</h3>
              <pre className="case-evidence__text">{text(item.expectedOutput)}</pre>
              <div className="case-evidence__versions">
                {resource.data?.promptVersions.map((version) => {
                  const result = item.results.find(
                    (r) => r.promptVersionId === version.promptVersionId,
                  );
                  return (
                    <section
                      className="flow-card flow-stack"
                      key={version.promptVersionId}
                      aria-label={`${version.label}的用例结果`}
                    >
                      <h3>
                        {version.label}
                        {version.isBaseline ? "（基线）" : ""}
                      </h3>
                      {result ? (
                        <CaseResult result={result} />
                      ) : (
                        <p>本版本尚无结果，未作为零分处理。</p>
                      )}
                    </section>
                  );
                })}
              </div>
            </details>
          ))}
          {!resource.data.items.length && <p>这一页没有用例。</p>}
        </>
      )}
      <nav className="flow-actions" aria-label="用例证据分页">
        <button
          className="button button--quiet"
          disabled={resource.loading || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          上一页用例
        </button>
        <button
          className="button button--quiet"
          disabled={resource.loading || !resource.data || offset + PAGE_SIZE >= resource.data.total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          下一页用例
        </button>
      </nav>
    </section>
  );
}

function CaseResult({ result }: { result: ExperimentCaseResult }) {
  const output = result.output;
  const overall = result.scores.find((s) => s.kind === "overall" && s.metricKey === "__overall__");
  return (
    <>
      {result.model && <p>生成模型：{result.model}</p>}
      {!output ? (
        <p>尚无回答记录，可能尚未执行或已终止。</p>
      ) : (
        <>
          <p>
            回答状态：
            {
              {
                pending: "等待生成",
                succeeded: "已生成",
                failed: "生成或评分失败",
                skipped: "已跳过",
              }[output.status]
            }
          </p>
          {output.outputText !== null && (
            <pre className="case-evidence__text">{output.outputText}</pre>
          )}
          {output.errorCode && (
            <p className="form-error">
              {output.errorCode}：{output.errorMessage || "执行未成功"}
            </p>
          )}
        </>
      )}
      <p>综合评分：{percent(overall?.normalizedScore ?? null)}</p>
      {!result.scores.length && <p>本条尚无评分，未作为零分处理。</p>}
      {result.failureCode && (
        <p className="form-error">
          任务级错误（不一定是本条的原因）：{result.failureCode} · {result.failureMessage}
        </p>
      )}
      {result.scores.map((score) => (
        <ScoreEvidence key={`${score.kind}-${score.metricKey}`} score={score} />
      ))}
    </>
  );
}

function ScoreEvidence({ score }: { score: CaseScore }) {
  return (
    <section className="case-evidence__score">
      <h4>
        {score.metricName}：{score.score} / {score.maxScore}
      </h4>
      <p>
        分值范围 {score.minScore}～{score.maxScore}；标准化 {percent(score.normalizedScore)}；
        {score.passed === null ? "未设置通过结论" : score.passed ? "通过" : "未通过"}； 评分置信度{" "}
        {score.confidence === null ? "未提供" : percent(score.confidence)}
        （模型自报，不代表实际准确率）
      </p>
      <p className="flow-wrap">评分理由：{score.rationale || "未提供"}</p>
      {score.evidence !== null && score.evidence !== undefined && (
        <details>
          <summary>查看评分引用的证据</summary>
          <pre className="case-evidence__text">{text(score.evidence)}</pre>
        </details>
      )}
    </section>
  );
}
