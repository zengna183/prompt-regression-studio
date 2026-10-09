import type { ExperimentComparison } from "@ai-chat-eval/contracts";
import type { ExperimentComparisonRecord } from "@ai-chat-eval/db";

const scoreEpsilon = 1e-12;

export function buildExperimentComparison(data: ExperimentComparisonRecord): ExperimentComparison {
  const baseline = data.promptVersions.find((version) => version.isBaseline);
  if (!baseline || data.promptVersions.filter((version) => version.isBaseline).length !== 1) {
    throw new Error("Experiment must contain exactly one baseline Prompt version");
  }
  const expectedObservationsPerVersion = data.datasetCaseCount * data.experiment.repetitions;
  if (!Number.isSafeInteger(expectedObservationsPerVersion) || expectedObservationsPerVersion < 1) {
    throw new Error("Experiment has an invalid expected observation count");
  }

  const overallByVersion = new Map(data.overall.map((item) => [item.promptVersionId, item]));
  const dimensionsByVersion = new Map<string, typeof data.dimensions>();
  for (const dimension of data.dimensions) {
    const existing = dimensionsByVersion.get(dimension.promptVersionId) ?? [];
    dimensionsByVersion.set(dimension.promptVersionId, [...existing, dimension]);
  }
  const observationsByVersion = new Map<string, typeof data.pairedObservations>();
  for (const observation of data.pairedObservations) {
    const existing = observationsByVersion.get(observation.promptVersionId) ?? [];
    observationsByVersion.set(observation.promptVersionId, [...existing, observation]);
  }
  const baselineObservations = new Map(
    (observationsByVersion.get(baseline.promptVersionId) ?? []).map((observation) => [
      observationKey(observation.caseId, observation.repetition),
      observation.normalizedScore,
    ]),
  );
  const baselineOverall = overallByVersion.get(baseline.promptVersionId);

  const versions = data.promptVersions.map((version) => {
    const overall = overallByVersion.get(version.promptVersionId);
    const observationCount = overall?.observationCount ?? 0;
    const averageScore = overall?.averageScore ?? null;
    const pairedComparison = version.isBaseline
      ? null
      : comparePairs(
          observationsByVersion.get(version.promptVersionId) ?? [],
          baselineObservations,
          expectedObservationsPerVersion,
        );
    return {
      promptVersionId: version.promptVersionId,
      label: version.label,
      isBaseline: version.isBaseline,
      rank: null as number | null,
      observationCount,
      coverageRate: boundedRate(observationCount, expectedObservationsPerVersion),
      averageScore,
      passRate: overall ? boundedRate(overall.passedCount, observationCount) : null,
      averageConfidence: overall?.averageConfidence ?? null,
      deltaFromBaseline:
        averageScore === null || baselineOverall === undefined
          ? null
          : clampScoreDelta(averageScore - baselineOverall.averageScore),
      pairedComparison,
      dimensions: (dimensionsByVersion.get(version.promptVersionId) ?? [])
        .map((dimension) => ({
          metricKey: dimension.metricKey,
          observationCount: dimension.observationCount,
          coverageRate: boundedRate(dimension.observationCount, expectedObservationsPerVersion),
          averageScore: dimension.averageScore,
          passRate: boundedRate(dimension.passedCount, dimension.observationCount),
          averageConfidence: dimension.averageConfidence,
        }))
        .sort((left, right) => left.metricKey.localeCompare(right.metricKey)),
    };
  });

  const ranked = versions
    .filter((version) => version.averageScore !== null)
    .sort((left, right) =>
      right.averageScore === left.averageScore
        ? left.label.localeCompare(right.label)
        : (right.averageScore ?? 0) - (left.averageScore ?? 0),
    );
  let previousScore: number | null = null;
  let previousRank = 0;
  ranked.forEach((version, index) => {
    const score = version.averageScore;
    if (score === null) return;
    if (previousScore === null || Math.abs(score - previousScore) > scoreEpsilon) {
      previousRank = index + 1;
      previousScore = score;
    }
    version.rank = previousRank;
  });

  const terminal = ["succeeded", "failed", "cancelled"].includes(data.experiment.status);
  return {
    experimentId: data.experiment.id,
    status: data.experiment.status,
    baselinePromptVersionId: baseline.promptVersionId,
    expectedObservationsPerVersion,
    isComplete:
      terminal &&
      versions.every((version) => version.observationCount >= expectedObservationsPerVersion),
    versions: versions.sort((left, right) => {
      if (left.rank === null)
        return right.rank === null ? left.label.localeCompare(right.label) : 1;
      if (right.rank === null) return -1;
      return left.rank - right.rank || left.label.localeCompare(right.label);
    }),
  };
}

function comparePairs(
  candidate: ExperimentComparisonRecord["pairedObservations"],
  baseline: ReadonlyMap<string, number>,
  expectedCount: number,
) {
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let deltaTotal = 0;
  for (const observation of candidate) {
    const baselineScore = baseline.get(observationKey(observation.caseId, observation.repetition));
    if (baselineScore === undefined) continue;
    const delta = observation.normalizedScore - baselineScore;
    deltaTotal += delta;
    if (delta > scoreEpsilon) wins += 1;
    else if (delta < -scoreEpsilon) losses += 1;
    else ties += 1;
  }
  const pairedCount = wins + ties + losses;
  return {
    pairedCount,
    coverageRate: boundedRate(pairedCount, expectedCount),
    wins,
    ties,
    losses,
    winRate: pairedCount === 0 ? null : (wins + ties * 0.5) / pairedCount,
    meanDelta: pairedCount === 0 ? null : clampScoreDelta(deltaTotal / pairedCount),
  };
}

function observationKey(caseId: string, repetition: number): string {
  return `${caseId}:${repetition}`;
}

function boundedRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
}

function clampScoreDelta(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
