import { describe, expect, it } from "vitest";
import {
  ArchiveManifestSchema,
  compactChapterStatuses,
  expandStatusRanges,
  formatChapterId,
  parseChapterId,
  parseVolumeStatusYaml,
  type ChapterStatusMetadata,
} from "../server/repository-domain.js";

describe("仓库领域 schema", () => {
  it("只接受规范的全书章 ID", () => {
    expect(parseChapterId("ch001")).toBe(1);
    expect(parseChapterId("ch1000")).toBe(1000);
    expect(formatChapterId(7)).toBe("ch007");
    expect(parseChapterId("ch01")).toBeNull();
    expect(parseChapterId("ch000")).toBeNull();
  });

  it("拒绝未知高版本状态 schema", () => {
    const parsed = parseVolumeStatusYaml("schema_version: 3\n", "状态.yaml");

    expect(parsed.document).toBeUndefined();
    expect(parsed.issues).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_SCHEMA_VERSION" }),
    ]);
  });

  it("卷状态 schema v2 允许展示名与目录字符解耦", () => {
    const parsed = parseVolumeStatusYaml(
      `schema_version: 2
volume:
  id: v01
  number: 1
  title: 上卷 / 长青少年
  status: active
  chapter_count: 0
canonical_root: 章节
status_authority: 本文件
status_ranges: []
`,
      "40_正文/卷/v01/状态.yaml",
    );

    expect(parsed.issues).toEqual([]);
    expect(parsed.document?.volume.title).toBe("上卷 / 长青少年");
  });

  it("旧版卷状态必须显式迁移，不能按 v2 猜测读取", () => {
    const parsed = parseVolumeStatusYaml("schema_version: 1\n", "状态.yaml");

    expect(parsed.document).toBeUndefined();
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ code: "INVALID_STATUS_SCHEMA" }),
    );
  });

  it("验证回收站清单的哈希与恢复字段", () => {
    expect(
      ArchiveManifestSchema.safeParse({
        schema_version: 1,
        archived_at: "2026-07-17T12:00:00.000Z",
        asset_type: "chapter",
        original_path: "40_正文/卷/v01/章节/ch016.md",
        archive_path: "99_归档/工作台回收站/example/ch016.md",
        reason: "测试",
        before_hash: "a".repeat(64),
        affected_references: [],
        restorable: true,
      }).success,
    ).toBe(true);
  });

  it("卷归档 schema v2 保存聚合身份和每棵目录树哈希", () => {
    expect(
      ArchiveManifestSchema.safeParse({
        schema_version: 2,
        archived_at: "2026-07-18T12:00:00.000Z",
        asset_type: "volume",
        reason: "测试卷归档",
        affected_references: [],
        restorable: true,
        volume_state: {
          volume_id: "v02",
          volume_number: 2,
          title: "第二卷",
          status: "planned",
        },
        assets: [
          {
            original_path: "40_正文/卷/v02",
            archive_path: "99_归档/工作台回收站/example/assets/40_正文/卷/v02",
            tree_hash: "b".repeat(64),
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("状态范围规范化", () => {
  it("诊断重叠范围而不静默采用第一项", () => {
    const expanded = expandStatusRanges(
      [
        {
          chapters: "ch001-ch002",
          status: "final",
          human_approved: true,
        },
        {
          chapters: "ch002-ch003",
          status: "ai-revised",
          human_approved: false,
        },
      ],
      "状态.yaml",
      "v01",
    );

    expect(expanded.issues).toContainEqual(
      expect.objectContaining({
        code: "OVERLAPPING_STATUS_RANGE",
        chapterId: "ch002",
      }),
    );
  });

  it.each(["ch003-ch001", "ch01-ch003", "ch000", "ch001-ch002-ch003"])(
    "拒绝非法范围 %s",
    (chapters) => {
      const expanded = expandStatusRanges(
        [{ chapters, status: "draft", human_approved: false }],
        "状态.yaml",
      );

      expect(expanded.issues[0]?.severity).toBe("blocking");
    },
  );

  it("只合并编号相邻且元数据相同的章节", () => {
    const draft: ChapterStatusMetadata = {
      status: "draft",
      humanApproved: false,
    };
    const statuses = new Map<number, ChapterStatusMetadata>([
      [1, draft],
      [2, draft],
      [4, draft],
    ]);

    expect(compactChapterStatuses(statuses)).toEqual([
      {
        chapters: "ch001-ch002",
        status: "draft",
        human_approved: false,
      },
      { chapters: "ch004", status: "draft", human_approved: false },
    ]);
  });
});
