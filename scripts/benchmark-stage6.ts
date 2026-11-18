import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { chapterMatchesQuery } from "../client/src/features/chapters/chapterFilter.js";
import {
  invalidateRepositoryReadModel,
  readRepositoryIndex,
} from "../server/repository.js";

const execFileAsync = promisify(execFile);
const VOLUME_COUNT = 5;
const CHAPTERS_PER_VOLUME = 100;
const COLD_RUNS = 3;
const HOT_RUNS_PER_COLD = 3;
const FILTER_RUNS = 20;
const LIMITS = { coldIndexMs: 3_000, hotIndexMs: 1_000, filterMs: 100 };

async function createBenchmarkRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "novel-stage6-benchmark-"));
  await Promise.all(
    [
      "00_项目",
      "10_圣经",
      "20_规划",
      "30_生产/active",
      "40_正文/卷",
      "50_审稿",
      "60_发布",
      "70_素材",
      "99_归档/工作台回收站",
    ].map((directory) =>
      mkdir(path.join(root, directory), { recursive: true }),
    ),
  );

  for (let volumeNumber = 1; volumeNumber <= VOLUME_COUNT; volumeNumber += 1) {
    const volumeId = `v${String(volumeNumber).padStart(2, "0")}`;
    const firstChapter = (volumeNumber - 1) * CHAPTERS_PER_VOLUME + 1;
    const lastChapter = firstChapter + CHAPTERS_PER_VOLUME - 1;
    const chapterRoot = path.join(root, "40_正文", "卷", volumeId, "章节");
    await mkdir(chapterRoot, { recursive: true });
    await writeFile(
      path.join(root, "40_正文", "卷", volumeId, "状态.yaml"),
      `schema_version: 2
volume:
  id: ${volumeId}
  number: ${volumeNumber}
  title: 性能卷 ${volumeNumber}
  status: active
  chapter_count: ${CHAPTERS_PER_VOLUME}
canonical_root: 章节
status_authority: 本文件
status_ranges:
  - chapters: ch${String(firstChapter).padStart(3, "0")}-ch${String(lastChapter).padStart(3, "0")}
    status: draft
    human_approved: false
`,
      "utf8",
    );
    await Promise.all(
      Array.from({ length: CHAPTERS_PER_VOLUME }, async (_, index) => {
        const number = firstChapter + index;
        const chapterId = `ch${String(number).padStart(3, "0")}`;
        await writeFile(
          path.join(chapterRoot, `${chapterId}.md`),
          `# 第 ${number} 章 性能样本\n\n这是第 ${number} 章的基准正文。\n`,
          "utf8",
        );
      }),
    );
  }
  return root;
}

async function measure<T>(operation: () => T | Promise<T>) {
  const startedAt = performance.now();
  const value = await operation();
  return { value, elapsedMs: performance.now() - startedAt };
}

function rounded(values: number[]): number[] {
  return values.map((value) => Number(value.toFixed(2)));
}

function summary(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
  return {
    min: Number(sorted[0]!.toFixed(2)),
    median: Number(percentile(0.5).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
    max: Number(sorted.at(-1)!.toFixed(2)),
  };
}

async function main() {
  const root = await createBenchmarkRepository();
  try {
    const coldRuns: number[] = [];
    const hotRuns: number[] = [];
    let chapters: Awaited<
      ReturnType<typeof readRepositoryIndex>
    >["volumes"][number]["chapters"] = [];

    for (let coldRun = 0; coldRun < COLD_RUNS; coldRun += 1) {
      invalidateRepositoryReadModel(root);
      const cold = await measure(() => readRepositoryIndex(root));
      coldRuns.push(cold.elapsedMs);
      chapters = cold.value.volumes.flatMap((volume) => volume.chapters);
      for (let hotRun = 0; hotRun < HOT_RUNS_PER_COLD; hotRun += 1) {
        hotRuns.push(
          (await measure(() => readRepositoryIndex(root))).elapsedMs,
        );
      }
    }

    const filterRuns: number[] = [];
    let filteredChapters = 0;
    for (let run = 0; run < FILTER_RUNS; run += 1) {
      const filtered = await measure(() =>
        chapters.filter((chapter) => chapterMatchesQuery(chapter, "性能样本")),
      );
      filteredChapters = filtered.value.length;
      filterRuns.push(filtered.elapsedMs);
    }

    const commit = await execFileAsync("git", ["rev-parse", "--short", "HEAD"])
      .then(({ stdout }) => stdout.trim())
      .catch(() => "unknown");
    const result = {
      commit: `${commit}+working-tree`,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      sample: {
        volumes: VOLUME_COUNT,
        chapters: chapters.length,
        filteredChapters,
      },
      thresholdsMs: LIMITS,
      coldIndex: { runsMs: rounded(coldRuns), ...summary(coldRuns) },
      hotIndex: { runsMs: rounded(hotRuns), ...summary(hotRuns) },
      filter: { runsMs: rounded(filterRuns), ...summary(filterRuns) },
    };
    console.log(JSON.stringify(result, null, 2));

    const failed =
      chapters.length !== VOLUME_COUNT * CHAPTERS_PER_VOLUME ||
      filteredChapters !== chapters.length ||
      coldRuns.some((value) => value >= LIMITS.coldIndexMs) ||
      hotRuns.some((value) => value >= LIMITS.hotIndexMs) ||
      filterRuns.some((value) => value >= LIMITS.filterMs);
    if (failed) process.exitCode = 1;
  } finally {
    invalidateRepositoryReadModel(root);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

await main();
