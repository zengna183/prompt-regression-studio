import type {
  DiagnosisReport,
  Evidence,
  HypothesisStatus,
  PromptChange,
  RootCauseHypothesis,
} from "../diagnosis/types";

interface DiagnosisReportViewProps {
  report: DiagnosisReport;
}

const changeLabels: Record<PromptChange["change_type"], string> = {
  added: "新增区段",
  removed: "删除区段",
  rewritten: "改写区段",
};

const statusDetails: Record<
  HypothesisStatus,
  { readonly symbol: string; readonly label: string; readonly explanation: string }
> = {
  supported: {
    symbol: "✓",
    label: "消融支持",
    explanation: "只回退相关区段后目标用例恢复，同时对照用例未出现超限损伤。",
  },
  rejected: {
    symbol: "×",
    label: "已否定",
    explanation: "消融结果没有支持这个解释，或结果变得更差。",
  },
  inconclusive: {
    symbol: "?",
    label: "证据不足",
    explanation: "样本量、恢复幅度或对照稳定性尚未达到决策门槛。",
  },
  hypothesized: {
    symbol: "…",
    label: "待验证",
    explanation: "这是根据失败与 Prompt 变化提出的候选解释，还没有消融证据。",
  },
};

export function DiagnosisReportView({ report }: DiagnosisReportViewProps) {
  const supportedRootCauses = report.hypotheses.filter((hypothesis) =>
    isSupportedRootCause(hypothesis, report.evidence),
  ).length;

  return (
    <article className="diagnosis-report" aria-labelledby="diagnosis-report-title">
      <header className="report-header">
        <div>
          <span className="eyebrow">DIAGNOSIS REPORT</span>
          <h2 id="diagnosis-report-title">诊断报告</h2>
          <p>
            比较 <code>{report.baseline_prompt_version_id}</code> 与{" "}
            <code>{report.candidate_prompt_version_id}</code>
          </p>
        </div>
        <span className="report-complete-mark" aria-label="诊断已完成">
          <span aria-hidden="true">✓</span> 已完成
        </span>
      </header>

      <dl className="report-summary" aria-label="诊断摘要">
        <SummaryMetric label="回归用例" value={report.regression.cases.length} />
        <SummaryMetric label="Prompt 改动" value={report.prompt_changes.length} />
        <SummaryMetric label="失败组" value={report.failure_clusters.length} />
        <SummaryMetric label="已支持根因" value={supportedRootCauses} />
      </dl>

      <aside className="causality-notice" aria-label="根因判定原则">
        <span className="causality-notice__icon" aria-hidden="true">
          i
        </span>
        <div>
          <strong>相关不等于因果</strong>
          <p>
            AI 可以提出假设，但只有受控消融达到证据门槛后，平台才称它为“已支持根因”。
            “待验证”“证据不足”和“已否定”都不是根因结论。
          </p>
        </div>
      </aside>

      {report.regression.cases.length === 0 ? (
        <section
          className="report-section report-section--quiet"
          aria-labelledby="no-regression-title"
        >
          <h3 id="no-regression-title">没有检测到达到门槛的回归</h3>
          <p>候选 Prompt 在这批配对用例中没有出现硬失败或超过阈值的主要指标下降。</p>
        </section>
      ) : null}

      <section className="report-section" aria-labelledby="prompt-changes-title">
        <SectionHeading
          id="prompt-changes-title"
          title="Prompt 改了哪里"
          description="按稳定区段 ID 对比，方便定位具体哪一段发生变化。"
        />
        {report.prompt_changes.length > 0 ? (
          <ol className="change-list">
            {report.prompt_changes.map((change) => (
              <li key={change.id} className="change-card">
                <div className="change-card__heading">
                  <span className={"change-kind change-kind--" + change.change_type}>
                    {changeLabels[change.change_type]}
                  </span>
                  <code>{change.segment_id}</code>
                </div>
                <p>{change.semantic_summary}</p>
                {change.semantic_tags.length > 0 ? (
                  <ul className="tag-list" aria-label="语义标签">
                    {change.semantic_tags.map((tag) => (
                      <li key={tag}>{tag}</li>
                    ))}
                  </ul>
                ) : null}
                <details className="evidence-details">
                  <summary>查看修改前后原文</summary>
                  <div className="prompt-diff">
                    <div>
                      <h4>修改前</h4>
                      <pre>{change.old_content ?? "（此前没有这个区段）"}</pre>
                    </div>
                    <div>
                      <h4>修改后</h4>
                      <pre>{change.new_content ?? "（候选版本已删除这个区段）"}</pre>
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        ) : (
          <p className="report-empty">没有发现区段级 Prompt 变化。</p>
        )}
      </section>

      <section className="report-section" aria-labelledby="failure-clusters-title">
        <SectionHeading
          id="failure-clusters-title"
          title="失败集中在哪里"
          description="把相似失败放在一组，避免逐条阅读时遗漏共同模式。"
        />
        {report.failure_clusters.length > 0 ? (
          <div className="cluster-grid">
            {report.failure_clusters.map((cluster) => (
              <article key={cluster.id} className="cluster-card">
                <span className="cluster-card__count">{cluster.test_case_ids.length} 个用例</span>
                <h3>{cluster.title}</h3>
                <p>
                  主要指标：<code>{cluster.primary_metric}</code>
                </p>
                <details>
                  <summary>技术信息</summary>
                  <p>
                    分组键：<code>{cluster.key}</code>
                    <br />
                    方法：{cluster.algorithm} / {cluster.algorithm_version}
                  </p>
                </details>
              </article>
            ))}
          </div>
        ) : (
          <p className="report-empty">没有回归用例，因此没有失败组。</p>
        )}
      </section>

      <section className="report-section" aria-labelledby="hypotheses-title">
        <SectionHeading
          id="hypotheses-title"
          title="归因假设与消融证据"
          description="每个候选解释都单独展示状态、目标恢复和最坏对照损伤。"
        />
        {report.hypotheses.length > 0 ? (
          <div className="hypothesis-list">
            {report.hypotheses.map((hypothesis, index) => (
              <HypothesisCard
                key={hypothesis.id}
                hypothesis={hypothesis}
                evidence={report.evidence.filter((item) => item.hypothesis_id === hypothesis.id)}
                changes={report.prompt_changes}
                ordinal={index + 1}
              />
            ))}
          </div>
        ) : (
          <p className="report-empty">当前没有需要验证的根因假设。</p>
        )}
      </section>

      <section className="report-section" aria-labelledby="recommendations-title">
        <SectionHeading
          id="recommendations-title"
          title="下一步建议"
          description="建议按顺序执行，并在修复后使用同一数据集重新评测。"
        />
        {report.recommendations.length > 0 ? (
          <ol className="recommendation-list">
            {report.recommendations.map((recommendation, index) => (
              <li key={String(index) + "-" + recommendation}>{recommendation}</li>
            ))}
          </ol>
        ) : (
          <p className="report-empty">暂无额外动作建议。</p>
        )}
      </section>

      <details className="report-provenance">
        <summary>查看报告技术信息与可追溯标识</summary>
        <dl>
          <div>
            <dt>报告 ID</dt>
            <dd>{report.report_id}</dd>
          </div>
          <div>
            <dt>评测包 ID</dt>
            <dd>{report.bundle_id}</dd>
          </div>
          <div>
            <dt>诊断引擎</dt>
            <dd>
              {report.pipeline.engine} / {report.pipeline.engine_version}
            </dd>
          </div>
          <div>
            <dt>输入摘要</dt>
            <dd>{report.input_bundle_hash}</dd>
          </div>
          <div>
            <dt>生成时间</dt>
            <dd>{report.generated_at}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

export function isSupportedRootCause(
  hypothesis: RootCauseHypothesis,
  allEvidence: readonly Evidence[],
): boolean {
  return (
    hypothesis.verification_status === "supported" &&
    allEvidence.some(
      (item) =>
        item.hypothesis_id === hypothesis.id &&
        item.stance === "supporting" &&
        item.resulting_status === "supported",
    )
  );
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SectionHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <header className="report-section__header">
      <h2 id={id}>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function HypothesisCard({
  hypothesis,
  evidence,
  changes,
  ordinal,
}: {
  hypothesis: RootCauseHypothesis;
  evidence: readonly Evidence[];
  changes: readonly PromptChange[];
  ordinal: number;
}) {
  const supportedRootCause = isSupportedRootCause(hypothesis, evidence);
  const declaredStatus = statusDetails[hypothesis.verification_status];
  const relatedSegments = changes
    .filter((change) => hypothesis.prompt_change_ids.includes(change.id))
    .map((change) => change.segment_id);

  return (
    <article
      className={
        "hypothesis-card hypothesis-card--" +
        (supportedRootCause ? "supported" : hypothesis.verification_status)
      }
    >
      <header className="hypothesis-card__header">
        <div>
          <span className="hypothesis-card__ordinal">假设 {ordinal}</span>
          <h3>{supportedRootCause ? "已支持根因" : "候选假设"}</h3>
        </div>
        <span className={"hypothesis-status hypothesis-status--" + hypothesis.verification_status}>
          <span aria-hidden="true">{declaredStatus.symbol}</span> {declaredStatus.label}
        </span>
      </header>

      <p className="hypothesis-explanation">{declaredStatus.explanation}</p>
      {hypothesis.verification_status === "supported" && !supportedRootCause ? (
        <p className="evidence-warning" role="alert">
          报告状态虽为“支持”，但没有对应的支持性消融证据，因此这里仍不能称为根因。
        </p>
      ) : null}
      <div className="hypothesis-copy">
        <h4>可能机制</h4>
        <p>{hypothesis.mechanism}</p>
        <h4>如果判断正确，应该看到</h4>
        <p>{hypothesis.expected_if_reverted}</p>
      </div>
      <p className="hypothesis-links">
        关联 Prompt 区段：
        {relatedSegments.length > 0
          ? relatedSegments.map((segment) => <code key={segment}>{segment}</code>)
          : "未找到对应区段"}
      </p>
      <p className="prior-score">规则初始排序分：{formatPercent(hypothesis.prior_confidence)}</p>

      {evidence.length > 0 ? (
        <div className="evidence-list">
          {evidence.map((item, index) => (
            <EvidenceCard key={item.id} evidence={item} ordinal={index + 1} />
          ))}
        </div>
      ) : (
        <div className="no-evidence">
          <strong>尚无消融证据，不能称为根因</strong>
          <p>下一步应只回退一个相关 Prompt 区段，并用相同模型、评判标准和测试集重跑。</p>
        </div>
      )}
    </article>
  );
}

function EvidenceCard({ evidence, ordinal }: { evidence: Evidence; ordinal: number }) {
  const stanceLabel =
    evidence.stance === "supporting"
      ? "支持性证据"
      : evidence.stance === "contradicting"
        ? "反对性证据"
        : "中性证据";
  return (
    <section className={"evidence-card evidence-card--" + evidence.stance}>
      <header>
        <h4>
          消融证据 {ordinal} · {stanceLabel}
        </h4>
        <code>{evidence.metric_key}</code>
      </header>
      <dl className="evidence-metrics">
        <div>
          <dt>目标恢复</dt>
          <dd>
            {evidence.recovery_ratio === null ? "无法计算" : formatPercent(evidence.recovery_ratio)}
          </dd>
          <small>相对原退化差距恢复了多少</small>
        </div>
        <div>
          <dt>最坏对照损伤</dt>
          <dd>{formatScore(evidence.max_observed_control_damage)}</dd>
          <small>任一正常用例的最大下降，不能被平均值抵消</small>
        </div>
        <div>
          <dt>目标平均变化</dt>
          <dd>{formatSignedScore(evidence.target_mean_delta)}</dd>
          <small>{evidence.target_sample_size} 个目标用例</small>
        </div>
        <div>
          <dt>对照平均变化</dt>
          <dd>{formatSignedScore(evidence.control_mean_delta)}</dd>
          <small>{evidence.control_sample_size} 个对照用例</small>
        </div>
      </dl>
      {evidence.unrecovered_hard_targets > 0 || evidence.new_control_failures > 0 ? (
        <ul className="evidence-flags" aria-label="消融风险信号">
          {evidence.unrecovered_hard_targets > 0 ? (
            <li>仍有 {evidence.unrecovered_hard_targets} 个硬回归未恢复</li>
          ) : null}
          {evidence.new_control_failures > 0 ? (
            <li>出现 {evidence.new_control_failures} 个新的对照失败</li>
          ) : null}
        </ul>
      ) : null}
      <details className="evidence-details">
        <summary>查看判定依据</summary>
        <p>{evidence.rationale}</p>
      </details>
    </section>
  );
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(value);
}

function formatScore(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(value);
}

function formatSignedScore(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 3,
    signDisplay: "always",
  }).format(value);
}
