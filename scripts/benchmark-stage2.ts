import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { chapterMatchesQuery } from "../client/src/features/chapters/chapterFilter.js";
import {
  invalidateRepositoryReadModel,
  readRepositoryIndex,
} from "../server/repository.js";

const execFileAsync = promisify(execFile);
const VOLUME_COUNT = 5;
const CHAPTERS_PER_VOLUME = 100;
const COLD_LIMIT_MS = 3_000;
const HOT_LIMIT_MS = 1_000;
const FILTER_LIMIT_MS = 100;

async function createBenchmarkRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "novel-stage2-benchmark-"));
  await Promise.all(
    ["10_圣经", "20_规划", "30_生产", "40_正文/卷", "50_审稿"].map(
      (directory) => mkdir(path.join(root, directory), { recursive: true }),
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

async function measure<T>(operation: () => Promise<T>) {
  const startedAt = performance.now();
  const value = await operation();
  return { value, elapsedMs: performance.now() - startedAt };
}

async function main() {
  const root = await createBenchmarkRepository();
  try {
    invalidateRepositoryReadModel(root);
    const cold = await measure(() => readRepositoryIndex(root));
    const hotRuns = [];
    for (let run = 0; run < 3; run += 1) {
      hotRuns.push((await measure(() => readRepositoryIndex(root))).elapsedMs);
    }
    hotRuns.sort((left, right) => left - right);
    const hotMedianMs = hotRuns[1]!;
    const chapters = cold.value.volumes.flatMap((volume) => volume.chapters);
    const filterStartedAt = performance.now();
    const filtered = chapters.filter((chapter) =>
      chapterMatchesQuery(chapter, "性能样本"),
    );
    const filterMs = performance.now() - filterStartedAt;
    const commit = await execFileAsync("git", ["rev-parse", "--short", "HEAD"])
      .then(({ stdout }) => stdout.trim())
      .catch(() => "unknown");
    const result = {
      commit: `${commit}+working-tree`,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      volumes: cold.value.volumes.length,
      chapters: chapters.length,
      coldIndexMs: Number(cold.elapsedMs.toFixed(2)),
      hotIndexMedianMs: Number(hotMedianMs.toFixed(2)),
      filterMs: Number(filterMs.toFixed(2)),
      filteredChapters: filtered.length,
      limitsMs: {
        coldIndex: COLD_LIMIT_MS,
        hotIndex: HOT_LIMIT_MS,
        filter: FILTER_LIMIT_MS,
      },
    };
    console.log(JSON.stringify(result, null, 2));
    if (
      chapters.length !== VOLUME_COUNT * CHAPTERS_PER_VOLUME ||
      cold.elapsedMs >= COLD_LIMIT_MS ||
      hotMedianMs >= HOT_LIMIT_MS ||
      filterMs >= FILTER_LIMIT_MS
    ) {
      process.exitCode = 1;
    }
  } finally {
    invalidateRepositoryReadModel(root);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

await main();
