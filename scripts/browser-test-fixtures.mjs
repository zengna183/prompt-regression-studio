/** Prepare published resources via real authenticated HTTP; browser actions start at login. */
export async function browserFixtures(http, provider, apiKey) {
  const project = await http(
    "POST",
    "/v1/projects",
    { slug: "browser-test", name: "浏览器验收" },
    201,
  );
  const base = `/v1/projects/${project.id}`;
  const prompt = await http(
    "POST",
    `${base}/prompts`,
    { key: "browser", name: "浏览器测试 Prompt" },
    201,
  );
  const version = async (policy, parent) => {
    const draft = await http(
      "POST",
      `/v1/prompts/${prompt.id}/versions`,
      {
        ...(parent ? { parentVersionId: parent.id } : {}),
        blocks: [
          { id: "role", kind: "role", name: "Role", content: "Answer the user" },
          { id: "policy", kind: "policy", name: "Policy", content: policy },
        ],
      },
      201,
    );
    return http("POST", `/v1/prompt-versions/${draft.id}/publish`);
  };
  const baseline = await version("GOOD_POLICY");
  const candidate = await version("BAD_POLICY", baseline);
  const rubric = await http(
    "POST",
    `${base}/frameworks`,
    { key: "quality", name: "回答质量" },
    201,
  );
  const rubricDraft = await http(
    "POST",
    `/v1/frameworks/${rubric.id}/versions`,
    {
      definition: {
        levels: [{ id: "quality", name: "Quality", description: "Fixture evaluation" }],
        dimensions: [
          {
            id: "quality",
            name: "Quality",
            description: "Matches expected answer",
            weight: 1,
            scoringGuide: [
              { score: 0, description: "bad" },
              { score: 1, description: "good" },
            ],
          },
        ],
      },
    },
    201,
  );
  const framework = await http("POST", `/v1/framework-versions/${rubricDraft.id}/publish`);
  const dataset = await http(
    "POST",
    `${base}/datasets`,
    { key: "browser", name: "浏览器测试集" },
    201,
  );
  const cases = Array.from({ length: 8 }, (_, i) => ({
    caseKey: `case-${i}`,
    input: `${i < 3 ? "target" : "control"}-${i}`,
    expectedOutput: "good",
    metadata: { domain: i < 3 ? "target" : "control" },
  }));
  const draft = await http("POST", `/v1/datasets/${dataset.id}/versions`, { cases }, 201);
  const reviewed = await http("POST", `/v1/dataset-versions/${draft.id}/review`, {
    cases,
    reviewerName: "Browser Test",
    acknowledged: true,
  });
  const datasetVersion = await http("POST", `/v1/dataset-versions/${reviewed.id}/publish`);
  const connection = await http(
    "POST",
    `${base}/model-connections`,
    {
      name: "本地验收模型",
      baseUrl: provider.baseUrl,
      apiKey,
      supportsSeed: true,
      allowedModels: ["system-generator", "system-judge"],
    },
    201,
  );
  return { project, prompt, baseline, candidate, framework, datasetVersion, connection };
}
