import { describe, expect, it } from "vitest";
import {
  ArchiveManifestSchema,
  DocumentArchiveManifestSchema,
  DocumentPathSchema,
  documentPolicy,
} from "../server/repository-domain.js";

describe("文档路径与权威等级策略", () => {
  it.each([
    ["10_圣经/人物/主角.md", "bible"],
    ["20_规划/全书/总纲.md", "plan"],
    ["70_素材/灵感/星海.md", "material"],
  ] as const)(
    "允许创建、编辑和归档受支持的当前 Markdown：%s",
    (relativePath, authority) => {
      expect(DocumentPathSchema.parse(relativePath)).toBe(relativePath);
      expect(documentPolicy(relativePath)).toMatchObject({
        authority,
        capabilities: {
          readable: true,
          creatable: true,
          editable: true,
          archivable: true,
        },
      });
    },
  );

  it.each([
    "40_正文/卷/v01/章节/ch002.md",
    "40_正文/卷/v01/状态.yaml",
    "30_生产/active/task/人工终审.md",
    "99_归档/旧设定.md",
    ".workbench/mutations/secret.md",
  ])("不允许普通文档写入绕过专用门禁：%s", (relativePath) => {
    const policy = documentPolicy(relativePath);
    if (!policy) {
      expect(policy).toBeNull();
    } else {
      expect(policy.capabilities).toMatchObject({
        creatable: false,
        editable: false,
        archivable: false,
      });
    }
  });

  it.each([
    "../仓库外.md",
    "/tmp/absolute.md",
    "C:/temp/absolute.md",
    "10_圣经/../../secret.md",
    "10_圣经/人物/主角.yaml",
    "10_圣经/人物\\主角.md",
  ])("拒绝不是规范仓库相对 Markdown 路径：%s", (relativePath) => {
    expect(DocumentPathSchema.safeParse(relativePath).success).toBe(false);
  });
});

describe("文档归档清单 v3", () => {
  const manifest = {
    schema_version: 3 as const,
    archived_at: "2026-07-18T05:00:00.000Z",
    asset_type: "document" as const,
    original_path: "10_圣经/人物/主角.md",
    archive_path:
      "99_归档/工作台回收站/2026-07-18T05-00-00.000Z-test/10_圣经/人物/主角.md",
    reason: "设定已废弃",
    before_hash: "a".repeat(64),
    authority: "bible" as const,
    affected_references: [],
    restorable: true,
  };

  it("应被文档专用 schema 和联合归档 schema 接受", () => {
    expect(DocumentArchiveManifestSchema.parse(manifest)).toEqual(manifest);
    expect(ArchiveManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("不允许伪造正文权威或遗漏原文哈希", () => {
    expect(
      DocumentArchiveManifestSchema.safeParse({
        ...manifest,
        authority: "canonical",
      }).success,
    ).toBe(false);
    const { before_hash: _beforeHash, ...withoutHash } = manifest;
    expect(DocumentArchiveManifestSchema.safeParse(withoutHash).success).toBe(
      false,
    );
  });
});
