import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import * as unzipper from "unzipper";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryFixture } from "./helpers/repository-fixture.js";
import { createRepositoryFixture } from "./helpers/repository-fixture.js";
import {
  buildCompactRevisionPackage,
  buildCompactTextRevisionPackage,
  buildContextPackage,
  buildRevisionPackage,
  contextCandidates,
  createTask,
  getTask,
  importReview,
  listTasks,
  recordDecisions,
} from "../server/tasks.js";

const fixtures: RepositoryFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("生产任务隔离", () => {
  it("创建任务完成后只发布最终目录，不留下临时目录", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    const activeEntries = await readdir(
      path.join(fixture.root, "30_生产", "active"),
      { withFileTypes: true },
    );

    expect(
      activeEntries
        .filter((entry) => entry.name.startsWith(".novel-task-"))
        .map((entry) => entry.name),
    ).toEqual([]);
    expect(task.directory).toBe(`30_生产/active/${task.id}`);
    expect(
      await readFile(
        path.join(fixture.root, task.directory, "task.yaml"),
        "utf8",
      ),
    ).toContain(`directory: ${task.directory}`);
  });

  it("上下文候选默认包含修订风格卡和当前卷修订上下文卡", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");

    await expect(contextCandidates(fixture.root, task.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "10_圣经/核心/修订风格卡.md",
          label: "修订风格卡",
          selected: true,
        }),
        expect.objectContaining({
          path: "20_规划/卷/v01/修订上下文卡.md",
          label: "当前卷修订上下文卡",
          selected: true,
        }),
      ]),
    );
  });

  it("拒绝 active 与 archive 中重复的任务 ID", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    const archiveDirectory = path.join(
      fixture.root,
      "30_生产",
      "archive",
      task.id,
    );
    await mkdir(archiveDirectory, { recursive: true });
    await writeFile(
      path.join(archiveDirectory, "task.yaml"),
      yaml.dump({
        ...task,
        stage: "archived",
        directory: `30_生产/archive/${task.id}`,
      }),
      "utf8",
    );

    await expect(getTask(fixture.root, task.id)).rejects.toMatchObject({
      code: "DUPLICATE_TASK_ID",
    });
    await expect(listTasks(fixture.root)).rejects.toMatchObject({
      code: "DUPLICATE_TASK_ID",
    });
  });

  it("拒绝归档位置与任务元数据身份不一致", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    const active = path.join(fixture.root, task.directory);
    const archive = path.join(fixture.root, "30_生产", "archive", task.id);
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(active, archive);

    await expect(getTask(fixture.root, task.id)).rejects.toMatchObject({
      code: "TASK_IDENTITY_MISMATCH",
    });
  });

  it("归档任务可读取但不能重新写入审稿报告", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    const active = path.join(fixture.root, task.directory);
    const archiveRelative = `30_生产/archive/${task.id}`;
    const archive = path.join(fixture.root, archiveRelative);
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(active, archive);
    await writeFile(
      path.join(archive, "task.yaml"),
      yaml.dump({ ...task, stage: "archived", directory: archiveRelative }),
      "utf8",
    );

    await expect(getTask(fixture.root, task.id)).resolves.toMatchObject({
      stage: "archived",
      directory: archiveRelative,
    });
    await expect(
      importReview(fixture.root, task.id, "不应写入"),
    ).rejects.toMatchObject({ code: "INVALID_STAGE" });
  });

  it("生成任务包后持久化所选候选资料并可恢复勾选状态", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    const selectedPaths = [
      "40_正文/卷/v01/章节/ch002.md",
      "10_圣经/人物/主角.md",
    ];

    const contextPackage = await buildContextPackage(
      fixture.root,
      task.id,
      selectedPaths,
    );

    expect(contextPackage.prompt).toContain("## 输出格式（必须严格遵守）");
    expect(contextPackage.prompt).toContain(
      "必须依次完成以下审查，不得在发现第一个问题后停止",
    );
    expect(contextPackage.prompt).toContain("## 证据与定级原则");
    expect(contextPackage.prompt).toContain(
      "存在两种合理解释、需要作者意图才能判断的内容",
    );
    expect(contextPackage.prompt).toContain("包内未提供某类资料时不得猜测");
    expect(contextPackage.prompt).toContain(
      "阻断问题：直接破坏核心设定、关键因果、人物身份或章节成立基础",
    );
    expect(contextPackage.prompt).toContain("## 提交前复核");
    expect(contextPackage.prompt).toContain(
      "只输出最终审稿报告，不输出上述检查过程或内部推理",
    );
    expect(contextPackage.prompt).toContain(
      "一个“## 序号. 标题”只代表一个问题",
    );
    expect(contextPackage.prompt).toContain(
      "每个问题必须同时包含“证据、影响、建议”三个小节",
    );

    const persisted = await getTask(fixture.root, task.id);
    expect(persisted.selectedContextPaths).toEqual(selectedPaths);
    const restored = await contextCandidates(fixture.root, task.id);
    expect(
      restored
        .filter((candidate) => candidate.selected)
        .map(({ path }) => path),
    ).toEqual(selectedPaths);
  });

  it("第五步修订包复用审查快照并携带审稿、决策和提示词", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    const relatedPath = "10_圣经/人物/主角.md";
    await writeFile(
      fixture.chapterPath,
      "# 外部改动\n\n不应进入任务包。\n",
      "utf8",
    );
    await buildContextPackage(fixture.root, task.id, [
      "40_正文/卷/v01/章节/ch002.md",
      relatedPath,
    ]);
    await writeFile(
      path.join(fixture.root, relatedPath),
      "# 已在审稿后改变的人物资料\n",
      "utf8",
    );
    const issues = await importReview(
      fixture.root,
      task.id,
      "## 重要问题\n- 修正一个表述问题\n",
    );

    await expect(
      buildRevisionPackage(fixture.root, task.id),
    ).rejects.toMatchObject({ code: "INVALID_STAGE" });
    await recordDecisions(fixture.root, task.id, [
      { id: issues[0].id, decision: "approved", note: "只调整表述" },
    ]);

    const built = await buildRevisionPackage(fixture.root, task.id);
    await expect(buildRevisionPackage(fixture.root, task.id)).resolves.toEqual(
      built,
    );
    const archive = await unzipper.Open.file(
      path.join(fixture.root, built.zipPath),
    );
    const files = new Map(
      archive.files
        .filter((entry) => entry.type === "File")
        .map((entry) => [entry.path, entry]),
    );
    const content = async (name: string) =>
      (await files.get(name)!.buffer()).toString("utf8");

    expect(files.has("原稿/01_输入快照.md")).toBe(true);
    expect(files.has(`相关资料/${relatedPath}`)).toBe(true);
    expect(files.has("审稿/03_审稿报告_原文.md")).toBe(true);
    expect(files.has("审稿/03_审稿问题.yaml")).toBe(true);
    expect(files.has("决策/04_人工决策.yaml")).toBe(true);
    expect(files.has("04_修订提示词.md")).toBe(true);
    expect(files.has("manifest.json")).toBe(true);
    expect(await content("原稿/01_输入快照.md")).toBe(fixture.originalChapter);
    expect(await content(`相关资料/${relatedPath}`)).toBe("# 主角\n");
    expect(await content("04_修订提示词.md")).toContain(
      "人工决策记录是本轮修改范围的唯一权威",
    );
    expect(await content("决策/04_人工决策.yaml")).toContain("只调整表述");
    expect(JSON.parse(await content("manifest.json"))).toMatchObject({
      schemaVersion: 1,
      taskId: task.id,
      volumeId: "v01",
      chapterId: "ch002",
    });
  });

  it("第五步精简包只携带冻结的必要上下文和已采纳决策", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    const selectedPaths = [
      "10_圣经/核心/写作规范.md",
      "10_圣经/核心/文学意义.md",
      "20_规划/全书/总纲.md",
      "20_规划/卷/v01/卷纲.md",
      "10_圣经/核心/修订风格卡.md",
      "20_规划/卷/v01/修订上下文卡.md",
      "40_正文/卷/v01/章节/ch001.md",
      "40_正文/卷/v01/章节/ch002.md",
      "40_正文/卷/v01/章节/ch003.md",
      "10_圣经/人物/主角.md",
    ];
    await Promise.all([
      writeFile(
        path.join(fixture.root, "10_圣经", "核心", "写作规范.md"),
        "# 完整写作规范\n",
        "utf8",
      ),
      writeFile(
        path.join(fixture.root, "10_圣经", "核心", "文学意义.md"),
        "# 完整文学意义\n",
        "utf8",
      ),
      mkdir(path.join(fixture.root, "20_规划", "全书"), { recursive: true }),
    ]);
    await writeFile(
      path.join(fixture.root, "20_规划", "全书", "总纲.md"),
      "# 完整全书总纲\n",
      "utf8",
    );
    await buildContextPackage(fixture.root, task.id, selectedPaths);
    await writeFile(
      path.join(fixture.root, "10_圣经", "核心", "修订风格卡.md"),
      "# 审稿后发生变化的风格卡\n",
      "utf8",
    );
    const issues = await importReview(
      fixture.root,
      task.id,
      `# 二、重要问题
## 1. 调整视角
**证据**
- 当前章：越过限知范围
**影响**
破坏信息边界。
**建议**
改回视角人物可知信息。

## 2. 收紧对白
**证据**
- 当前章：对白解释过多
**影响**
削弱人物声音。
**建议**
删除解释。

## 3. 改写结局
**证据**
- 当前章：结局不够激烈
**影响**
可选体验。
**建议**
改成战斗。
`,
    );
    await recordDecisions(fixture.root, task.id, [
      { id: issues[0]!.id, decision: "approved", note: "按建议修正" },
      {
        id: issues[1]!.id,
        decision: "partially-approved",
        note: "只删重复解释，不改语气",
      },
      { id: issues[2]!.id, decision: "rejected", note: "保持原结局" },
    ]);

    const built = await buildCompactRevisionPackage(fixture.root, task.id);
    const archive = await unzipper.Open.file(
      path.join(fixture.root, built.zipPath),
    );
    const files = new Map(
      archive.files
        .filter((entry) => entry.type === "File")
        .map((entry) => [entry.path, entry]),
    );
    const content = async (name: string) =>
      (await files.get(name)!.buffer()).toString("utf8");

    expect(built.zipPath).toContain("04_AI修订精简包.zip");
    expect(files.has("原稿/01_输入快照.md")).toBe(true);
    expect(files.has("上下文/修订风格卡.md")).toBe(true);
    expect(files.has("上下文/当前卷修订上下文卡.md")).toBe(true);
    expect(files.has("相邻章节/ch001.md")).toBe(true);
    expect(files.has("相邻章节/ch003.md")).toBe(true);
    expect(files.has("专题资料/10_圣经/人物/主角.md")).toBe(true);
    expect(files.has("决策/已批准修改.md")).toBe(true);
    expect(files.has("04_修订提示词.md")).toBe(true);
    expect(files.has("manifest.json")).toBe(true);
    expect(await content("上下文/修订风格卡.md")).toContain("准确、克制");
    expect(await content("决策/已批准修改.md")).toContain("调整视角");
    expect(await content("决策/已批准修改.md")).toContain(
      "只删重复解释，不改语气",
    );
    expect(await content("决策/已批准修改.md")).not.toContain("改写结局");
    expect([...files.keys()]).not.toEqual(
      expect.arrayContaining([
        "相关资料/10_圣经/核心/写作规范.md",
        "相关资料/10_圣经/核心/文学意义.md",
        "相关资料/20_规划/全书/总纲.md",
        "相关资料/20_规划/卷/v01/卷纲.md",
        "审稿/03_审稿报告_原文.md",
        "审稿/03_审稿问题.yaml",
        "决策/04_人工决策.yaml",
      ]),
    );
  });

  it("旧任务未冻结上下文卡时拒绝生成精简包", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    await buildContextPackage(fixture.root, task.id, [
      "40_正文/卷/v01/章节/ch002.md",
      "10_圣经/人物/主角.md",
    ]);
    const issues = await importReview(
      fixture.root,
      task.id,
      "## 重要问题\n- 修正一个表述问题\n",
    );
    await recordDecisions(fixture.root, task.id, [
      { id: issues[0]!.id, decision: "approved" },
    ]);

    await expect(
      buildCompactRevisionPackage(fixture.root, task.id),
    ).rejects.toMatchObject({ code: "MISSING_COMPACT_CONTEXT_CARDS" });
  });

  it("单文件任务包与精简 ZIP 共用业务条目并保持 UTF-8 无 BOM", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    const selectedPaths = [
      "10_圣经/核心/修订风格卡.md",
      "20_规划/卷/v01/修订上下文卡.md",
      "40_正文/卷/v01/章节/ch001.md",
      "40_正文/卷/v01/章节/ch002.md",
      "40_正文/卷/v01/章节/ch003.md",
      "10_圣经/人物/主角.md",
    ];
    await buildContextPackage(fixture.root, task.id, selectedPaths);
    const issues = await importReview(
      fixture.root,
      task.id,
      `# 二、重要问题
## 1. 调整视角
**证据**
- 当前章：越过限知范围
**影响**
破坏信息边界。
**建议**
改回视角人物可知信息。

## 2. 改写结局
**证据**
- 当前章：结局不够激烈
**影响**
可选体验。
**建议**
改成战斗。
`,
    );
    await recordDecisions(fixture.root, task.id, [
      { id: issues[0]!.id, decision: "approved", note: "只修正这一处" },
      { id: issues[1]!.id, decision: "rejected", note: "保持原结局" },
    ]);

    const compactZip = await buildCompactRevisionPackage(fixture.root, task.id);
    const compactText = await buildCompactTextRevisionPackage(
      fixture.root,
      task.id,
    );
    const textBytes = await readFile(
      path.join(fixture.root, compactText.textPath),
    );
    const text = textBytes.toString("utf8");
    const archive = await unzipper.Open.file(
      path.join(fixture.root, compactZip.zipPath),
    );
    const businessEntries = archive.files.filter(
      (entry) => entry.type === "File" && entry.path !== "manifest.json",
    );

    expect(compactText.textPath).toContain("04_AI修订精简单文件.txt");
    expect([...textBytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toContain("# 小说 AI 修订单文件任务包");
    expect(text).toContain(`- 任务：${task.id}`);
    expect(text).toContain("只按“已批准修改”处理");
    for (const entry of businessEntries) {
      const content = await entry.buffer();
      const sha256 = createHash("sha256").update(content).digest("hex");
      expect(text).toContain(
        `<!-- NOVEL_FILE_BEGIN ${JSON.stringify({
          path: entry.path,
          bytes: content.byteLength,
          sha256,
        })} -->`,
      );
      expect(text).toContain(content.toString("utf8"));
    }
    expect(text).toContain("调整视角");
    expect(text).not.toContain("改写结局");
    expect(text).not.toContain("manifest.json");
  });

  it("旧任务缺少元数据时从 ZIP 清单恢复所选资料", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    const selectedPaths = ["40_正文/卷/v01/章节/ch002.md"];
    await buildContextPackage(fixture.root, task.id, selectedPaths);
    const taskPath = path.join(fixture.root, task.directory, "task.yaml");
    const record = yaml.load(await readFile(taskPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete record.selectedContextPaths;
    await writeFile(taskPath, yaml.dump(record), "utf8");

    const restored = await contextCandidates(fixture.root, task.id);

    expect(
      restored
        .filter((candidate) => candidate.selected)
        .map(({ path }) => path),
    ).toEqual(selectedPaths);
  });

  it("创建任务只复制输入快照，不覆盖正式正文", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);

    const task = await createTask(fixture.root, "v01", "ch002");
    const snapshot = await readFile(
      path.join(fixture.root, task.directory, "01_输入快照.md"),
      "utf8",
    );

    expect(snapshot).toBe(fixture.originalChapter);
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);
  });

  it("无论审稿解析结果如何都逐字保留原文", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    await buildContextPackage(fixture.root, task.id, [
      "40_正文/卷/v01/章节/ch002.md",
    ]);
    const raw =
      "自由格式审稿，没有列表，也不满足解析器格式。\n第二行仍须保留。\n";

    const issues = await importReview(fixture.root, task.id, raw);
    const persisted = await readFile(
      path.join(fixture.root, task.directory, "03_审稿报告_原文.md"),
      "utf8",
    );

    expect(issues).toEqual([]);
    expect(persisted).toBe(raw);
    expect(await fixture.readChapter()).toBe(fixture.originalChapter);
  });

  it("刷新恢复到已导入阶段后仍可重新保存并解析审稿报告", async () => {
    const fixture = await createRepositoryFixture();
    fixtures.push(fixture);
    const task = await createTask(fixture.root, "v01", "ch002");
    await buildContextPackage(fixture.root, task.id, [
      "40_正文/卷/v01/章节/ch002.md",
    ]);
    await importReview(fixture.root, task.id, "## 重要问题\n- 旧问题\n");
    const refreshedTask = await getTask(fixture.root, task.id);
    expect(refreshedTask.stage).toBe("review-imported");

    const replacement = "## 重要问题\n- 新问题一\n- 新问题二\n";
    const issues = await importReview(fixture.root, task.id, replacement);
    const persisted = await readFile(
      path.join(fixture.root, task.directory, "03_审稿报告_原文.md"),
      "utf8",
    );

    expect(issues.map(({ title }) => title)).toEqual(["新问题一", "新问题二"]);
    expect(persisted).toBe(replacement);
    expect((await getTask(fixture.root, task.id)).pendingDecisionCount).toBe(2);

    await recordDecisions(
      fixture.root,
      task.id,
      issues.map(({ id }) => ({ id, decision: "approved" })),
    );
    await expect(
      importReview(fixture.root, task.id, "## 重要问题\n- 不应覆盖\n"),
    ).rejects.toThrow("当前阶段不能保存并解析审稿报告");
  });
});
