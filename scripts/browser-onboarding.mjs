import assert from "node:assert/strict";

/** Every resource is created through the UI; HTTP responses only identify and verify it. */
export async function browserOnboarding({ page, expect, check, provider, apiKey }) {
  const navigate = (title) =>
    page
      .getByRole("navigation", { name: "主要功能" })
      .getByRole("button", { name: new RegExp(title, "u") })
      .click();
  const submit = async (suffix, action, status = 201) => {
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(suffix) && r.request().method() === "POST"),
      action(),
    ]);
    assert.equal(response.status(), status, `UI submission ${suffix}`);
    return response.json();
  };
  const fits = async (label) => {
    const result = await page.evaluate(() => ({
      width: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      outside: [...document.querySelectorAll("input, select, textarea, button, fieldset")]
        .filter((item) => {
          const r = item.getBoundingClientRect();
          return r.width && (r.right > innerWidth + 1 || r.left < -1);
        })
        .slice(0, 8)
        .map((item) => `${item.tagName}.${item.className}`),
    }));
    assert(
      result.documentWidth <= result.width + 1,
      `${label}: page overflows ${JSON.stringify(result)}`,
    );
  };
  await page.setViewportSize({ width: 390, height: 844 });
  let project, prompt, baseline, candidate, datasetVersion, framework, connection;
  await check(
    "create an empty project in a narrow browser without pre-seeded resources",
    async () => {
      await expect(page.getByRole("heading", { name: "从一个评测项目开始" })).toBeVisible();
      await page.getByRole("button", { name: "创建第一个项目", exact: true }).click();
      await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("浏览器验收");
      project = await submit("/v1/projects", () =>
        page.locator("form").getByRole("button", { name: "创建项目", exact: true }).click(),
      );
      await expect(page.getByRole("heading", { name: "从一个问题，到有依据的改进" })).toBeVisible();
      await expect(page.locator(".flow-steps").getByText("待准备", { exact: true })).toHaveCount(5);
      await fits("empty project");
    },
  );
  const projectPath = `/v1/projects/${project.id}`;
  await check(
    "create and test an encrypted model connection; failed save is retryable",
    async () => {
      await navigate("模型连接");
      await page.getByRole("textbox", { name: "连接名称", exact: true }).fill("本地验收模型");
      await page.getByRole("textbox", { name: "服务地址", exact: true }).fill(provider.baseUrl);
      const secret = page.getByLabel("API Key（供应商提供的调用密钥）", { exact: false });
      await secret.fill(apiKey);
      await page
        .getByRole("textbox", { name: "可用模型名称", exact: true })
        .fill("system-generator\nsystem-judge");
      // One injected failure checks that a real user can retry without losing the form.
      const url = new URL(`/api${projectPath}/model-connections`, page.url()).href;
      await page.route(
        url,
        (route) =>
          route.request().method() === "POST"
            ? route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({ message: "Temporary test outage" }),
              })
            : route.continue(),
        { times: 1 },
      );
      await submit(
        `${projectPath}/model-connections`,
        () => page.getByRole("button", { name: "保存连接", exact: true }).click(),
        503,
      );
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByRole("textbox", { name: "连接名称", exact: true })).toHaveValue(
        "本地验收模型",
      );
      await expect(secret).toHaveValue("");
      await secret.fill(apiKey);
      connection = await submit(`${projectPath}/model-connections`, () =>
        page.getByRole("button", { name: "保存连接", exact: true }).click(),
      );
      assert(!JSON.stringify(connection).includes(apiKey), "API key leaked in connection response");
      await expect(secret).toHaveValue("");
      await expect(page.getByRole("alert")).toHaveCount(0);
      const tested = await submit(
        `/model-connections/${connection.id}/test`,
        () =>
          page.getByRole("button", { name: "测试连接（会产生少量模型调用）", exact: true }).click(),
        200,
      );
      assert.equal(tested.reachable, true);
      await expect(page.getByText("连接正常，模型已成功返回回答。", { exact: true })).toBeVisible();
      await fits("model connection");
    },
  );
  await check(
    "create and publish two Prompt versions preserving the changed block identity",
    async () => {
      await navigate("Prompt 版本");
      await page.getByRole("button", { name: "新建 Prompt", exact: true }).first().click();
      await page
        .getByRole("textbox", { name: "Prompt 名称", exact: true })
        .fill("浏览器测试 Prompt");
      prompt = await submit(`${projectPath}/prompts`, () =>
        page.getByRole("button", { name: "创建 Prompt", exact: true }).click(),
      );
      await page.getByRole("button", { name: "创建第一个版本", exact: true }).click();
      await page
        .getByRole("group", { name: "区块 1", exact: true })
        .getByRole("textbox", { name: "Prompt 内容", exact: true })
        .fill("Answer the user");
      await page
        .getByRole("combobox", { name: "选择要添加的区块类型", exact: true })
        .selectOption("policy");
      await page
        .getByRole("group", { name: "区块 2", exact: true })
        .getByRole("textbox", { name: "Prompt 内容", exact: true })
        .fill("GOOD_POLICY");
      await page
        .getByRole("textbox", { name: "本次修改说明（推荐填写）", exact: true })
        .fill("原始规则");
      await fits("Prompt editor");
      baseline = await submit(`/prompts/${prompt.id}/versions`, () =>
        page.getByRole("button", { name: "保存为新草稿", exact: true }).click(),
      );
      const publish = async (version, summary) => {
        const row = page.getByRole("row").filter({ hasText: summary });
        page.once("dialog", (dialog) => dialog.accept());
        const result = await submit(
          `/prompt-versions/${version.id}/publish`,
          () => row.getByRole("button", { name: "发布", exact: true }).click(),
          200,
        );
        await expect(row).toContainText("已发布");
        return result;
      };
      baseline = await publish(baseline, "原始规则");
      await page
        .getByRole("row")
        .filter({ hasText: "原始规则" })
        .getByRole("button", { name: "基于此版本新建", exact: true })
        .click();
      await page
        .getByRole("group", { name: "区块 2", exact: true })
        .getByRole("textbox", { name: "Prompt 内容", exact: true })
        .fill("BAD_POLICY");
      await page
        .getByRole("textbox", { name: "本次修改说明（推荐填写）", exact: true })
        .fill("修改规则");
      candidate = await submit(`/prompts/${prompt.id}/versions`, () =>
        page.getByRole("button", { name: "保存为新草稿", exact: true }).click(),
      );
      candidate = await publish(candidate, "修改规则");
      assert.equal(candidate.parentVersionId, baseline.id);
      assert.equal(candidate.blocks[1].id, baseline.blocks[1].id);
      await fits("published Prompt table");
    },
  );
  await check(
    "manually enter, individually review and publish cases without bypassing approval",
    async () => {
      await navigate("评测集");
      await page.getByRole("textbox", { name: "名称", exact: true }).fill("浏览器测试集");
      const dataset = await submit(`${projectPath}/datasets`, () =>
        page.getByRole("button", { name: "创建评测集", exact: true }).click(),
      );
      await page.getByText("手动添加用例（无需准备文件）", { exact: true }).click();
      const manual = page.getByRole("group", { name: "本版用例", exact: true });
      for (let i = 0; i < 8; i++) {
        if (i) await manual.getByRole("button", { name: "再加一条用例", exact: true }).click();
        await manual
          .getByRole("textbox", { name: "对话输入", exact: true })
          .nth(i)
          .fill(`${i < 3 ? "target" : "control"}-${i}`);
        await manual
          .getByRole("textbox", { name: "期望回答或判定依据（可选）", exact: true })
          .nth(i)
          .fill("good");
      }
      const draft = await submit(`/datasets/${dataset.id}/versions`, () =>
        page.getByRole("button", { name: "保存手动用例草稿", exact: true }).click(),
      );
      assert.equal(draft.reviewedAt, null);
      const review = page.getByRole("region", {
        name: `查看与审核 v${draft.version}`,
        exact: true,
      });
      const approve = review.getByRole("button", { name: "确认审核并保存", exact: true });
      await expect(approve).toBeDisabled();
      await expect(review.getByRole("button", { name: "发布已审核版本", exact: true })).toHaveCount(
        0,
      );
      const boxes = review.getByRole("checkbox", {
        name: "我已核对这条用例和参考回答",
        exact: true,
      });
      await expect(boxes).toHaveCount(8);
      await boxes.nth(0).check();
      await review
        .getByRole("textbox", { name: "用户输入", exact: true })
        .nth(0)
        .fill("target-reviewed-0");
      await expect(boxes.nth(0)).not.toBeChecked();
      for (let i = 0; i < 7; i++) await boxes.nth(i).check();
      await expect(approve).toBeDisabled();
      await boxes.nth(7).check();
      const reviewed = await submit(
        `/dataset-versions/${draft.id}/review`,
        () => approve.click(),
        200,
      );
      assert(reviewed.reviewedAt);
      assert.equal(reviewed.reviewedBy, "Browser Test");
      datasetVersion = await submit(
        `/dataset-versions/${reviewed.id}/publish`,
        () => page.getByRole("button", { name: "发布已审核版本", exact: true }).click(),
        200,
      );
      assert.equal(datasetVersion.status, "published");
      await expect(
        page
          .getByRole("region", { name: `查看与审核 v${datasetVersion.version}`, exact: true })
          .getByRole("textbox", { name: "用户输入", exact: true })
          .first(),
      ).toBeDisabled();
      await fits("reviewed dataset");
    },
  );
  await check(
    "configure and publish a rubric; reject invalid weights and verify responsive readiness",
    async () => {
      await navigate("评判标准");
      await page.getByRole("textbox", { name: "名称", exact: true }).fill("回答质量");
      const rubric = await submit(`${projectPath}/frameworks`, () =>
        page.getByRole("button", { name: "创建标准", exact: true }).click(),
      );
      await page.getByRole("textbox", { name: "维度名称", exact: true }).fill("回答质量");
      await page
        .getByRole("textbox", { name: "评判说明", exact: true })
        .fill("回答应符合参考答案，不得编造事实。");
      await page.getByRole("spinbutton", { name: "权重（%）", exact: true }).fill("90");
      await page.getByRole("button", { name: "保存为新草稿", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("100%");
      await page.getByRole("spinbutton", { name: "权重（%）", exact: true }).fill("100");
      const draft = await submit(`/frameworks/${rubric.id}/versions`, () =>
        page.getByRole("button", { name: "保存为新草稿", exact: true }).click(),
      );
      framework = await submit(
        `/framework-versions/${draft.id}/publish`,
        () =>
          page.getByRole("button", { name: `发布已保存的 v${draft.version}`, exact: true }).click(),
        200,
      );
      await expect(
        page.getByText("版本已发布，可以在新实验中选择。", { exact: true }),
      ).toBeVisible();
      await fits("rubric editor");
      await navigate("开始评测");
      await expect(page.locator(".flow-steps").getByText("已具备", { exact: true })).toHaveCount(4);
      for (const width of [320, 768, 1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await fits(`readiness at ${width}px`);
      }
    },
  );
  return {
    project,
    prompt,
    baseline,
    candidate,
    datasetVersion,
    framework,
    connection,
    policyBlockId: baseline.blocks[1].id,
    fits,
  };
}
