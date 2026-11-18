import yaml from "js-yaml";
import { z } from "zod";
import type {
  DocumentAuthority,
  DocumentCapabilities,
  RepositoryHealthIssue,
} from "../shared/contracts.js";

const CHAPTER_ID_PATTERN = /^ch(?:00[1-9]|0[1-9]\d|[1-9]\d{2,})$/;
const VOLUME_ID_PATTERN = /^v(?:0[1-9]|[1-9]\d+)$/;
const SAFE_DIRECTORY_PATTERN = /^(?!\.{1,2}$)[^\\/\0\r\n]+$/;
const SINGLE_LINE_PATTERN = /^[^\r\n]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/** 工作台托管的小说封面唯一仓库路径。 */
export const NOVEL_COVER_PATH = "70_素材/封面.png" as const;
/** 单个小说封面允许的最大原始字节数。 */
export const MAX_NOVEL_COVER_BYTES = 5 * 1024 * 1024;
const MAX_NOVEL_COVER_BASE64_LENGTH = Math.ceil(MAX_NOVEL_COVER_BYTES / 3) * 4;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 校验由浏览器文件选择器提交的 PNG 封面载荷。 */
export const NovelCoverUploadSchema = z
  .object({
    name: z.string().min(1).max(255),
    mimeType: z.literal("image/png"),
    contentBase64: z.string().min(1).max(MAX_NOVEL_COVER_BASE64_LENGTH),
  })
  .strict()
  .superRefine((upload, context) => {
    if (!upload.name.toLocaleLowerCase("en-US").endsWith(".png")) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "封面文件名必须以 .png 结尾",
      });
    }
    if (
      upload.contentBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(upload.contentBase64)
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentBase64"],
        message: "封面内容不是规范 Base64",
      });
      return;
    }
    const content = Buffer.from(upload.contentBase64, "base64");
    if (
      content.length === 0 ||
      content.length > MAX_NOVEL_COVER_BYTES ||
      content.toString("base64") !== upload.contentBase64
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentBase64"],
        message: "封面大小无效或超过 5 MiB",
      });
      return;
    }
    if (!content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      context.addIssue({
        code: "custom",
        path: ["contentBase64"],
        message: "封面内容不是有效的 PNG 文件",
      });
    }
  });

export const ChapterIdSchema = z.string().regex(CHAPTER_ID_PATTERN);
export const VolumeIdSchema = z.string().regex(VOLUME_ID_PATTERN);
export const ChapterStatusSchema = z.enum([
  "draft",
  "ai-revised",
  "human-revising",
  "final",
]);

export const StatusRangeSchema = z
  .object({
    chapters: z.string().min(1),
    status: ChapterStatusSchema,
    human_approved: z.boolean(),
    review_gate: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

export const VolumeStatusDocumentSchema = z
  .object({
    schema_version: z.literal(2),
    volume: z
      .object({
        id: VolumeIdSchema,
        number: z.number().int().positive().safe(),
        title: z.string().trim().min(1).max(120).regex(SINGLE_LINE_PATTERN),
        status: z.enum(["planned", "active", "archived"]),
        chapter_count: z.number().int().nonnegative().safe(),
      })
      .strict(),
    canonical_root: z.string().regex(SAFE_DIRECTORY_PATTERN),
    status_authority: z.literal("本文件"),
    status_ranges: z.array(StatusRangeSchema),
    historical_review_records: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const NovelMetadataSchema = z
  .object({
    schema_version: z.literal(1),
    novel: z
      .object({
        id: z.string().trim().min(1).max(120).regex(SINGLE_LINE_PATTERN),
        title: z.string().trim().min(1).max(120).regex(SINGLE_LINE_PATTERN),
        author: z
          .string()
          .trim()
          .max(120)
          .regex(/^[^\r\n]*$/),
        description: z.string().max(20_000),
        cover: z.literal(NOVEL_COVER_PATH).optional(),
        current_volume: VolumeIdSchema.optional(),
        current_chapter: ChapterIdSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const ChapterArchiveManifestSchema = z
  .object({
    schema_version: z.literal(1),
    archived_at: z.string().datetime(),
    asset_type: z.enum(["volume", "chapter", "document"]),
    original_path: z.string().min(1),
    archive_path: z.string().min(1),
    reason: z.string().min(1),
    before_hash: z.string().regex(SHA256_PATTERN),
    affected_references: z.array(z.string()),
    restorable: z.boolean(),
    restored_at: z.string().datetime().optional(),
    chapter_state: z
      .object({
        volume_id: VolumeIdSchema,
        chapter_id: ChapterIdSchema,
        status: ChapterStatusSchema,
        human_approved: z.boolean(),
        review_gate: z.string().min(1).optional(),
        note: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const VolumeArchiveManifestSchema = z
  .object({
    schema_version: z.literal(2),
    archived_at: z.string().datetime(),
    asset_type: z.literal("volume"),
    reason: z.string().min(1),
    affected_references: z.array(z.string()),
    restorable: z.boolean(),
    restored_at: z.string().datetime().optional(),
    volume_state: z
      .object({
        volume_id: VolumeIdSchema,
        volume_number: z.number().int().positive().safe(),
        title: z.string().trim().min(1).max(120).regex(SINGLE_LINE_PATTERN),
        status: z.enum(["planned", "active", "archived"]),
      })
      .strict(),
    assets: z
      .array(
        z
          .object({
            original_path: z.string().min(1),
            archive_path: z.string().min(1),
            tree_hash: z.string().regex(SHA256_PATTERN),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const DocumentArchiveManifestSchema = z
  .object({
    schema_version: z.literal(3),
    archived_at: z.string().datetime(),
    asset_type: z.literal("document"),
    original_path: z.string().min(1),
    archive_path: z.string().min(1),
    reason: z.string().min(1).max(500),
    before_hash: z.string().regex(SHA256_PATTERN),
    authority: z.enum(["bible", "approved-plan", "plan", "material"]),
    affected_references: z.array(z.string()),
    restorable: z.boolean(),
    restored_at: z.string().datetime().optional(),
  })
  .strict();

export const ArchiveManifestSchema = z.union([
  ChapterArchiveManifestSchema,
  VolumeArchiveManifestSchema,
  DocumentArchiveManifestSchema,
]);

export type VolumeStatusDocument = z.infer<typeof VolumeStatusDocumentSchema>;
export type StatusRange = z.infer<typeof StatusRangeSchema>;
export type KnownChapterStatus = z.infer<typeof ChapterStatusSchema>;
export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;
export type VolumeArchiveManifest = z.infer<typeof VolumeArchiveManifestSchema>;
export type DocumentArchiveManifest = z.infer<
  typeof DocumentArchiveManifestSchema
>;

const DOCUMENT_ROOTS = new Map<
  string,
  { authority: DocumentAuthority; writable: boolean }
>([
  ["10_圣经", { authority: "bible", writable: true }],
  ["20_规划", { authority: "plan", writable: true }],
  ["30_生产", { authority: "production", writable: false }],
  ["40_正文", { authority: "canonical", writable: false }],
  ["50_审稿", { authority: "review", writable: false }],
  ["60_发布", { authority: "production", writable: false }],
  ["70_素材", { authority: "material", writable: true }],
  ["99_归档", { authority: "archive", writable: false }],
]);

const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export const DocumentPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !value.includes("\\") && !value.startsWith("/"), {
    message: "文档路径必须是 POSIX 仓库相对路径",
  })
  .refine((value) => /\.md$/i.test(value), { message: "仅支持 Markdown 文档" })
  .refine(
    (value) =>
      value
        .split("/")
        .every(
          (part) =>
            part.length > 0 &&
            part !== "." &&
            part !== ".." &&
            !/[\0-\x1f]/.test(part) &&
            !part.includes(":") &&
            !/[. ]$/.test(part) &&
            !WINDOWS_RESERVED_NAME.test(part),
        ),
    { message: "文档路径包含不安全的路径段" },
  );

/** 返回统一的文档权威等级与 CRUD 能力；未纳入文档库的路径返回 null。 */
export function documentPolicy(relativePath: string): {
  authority: DocumentAuthority;
  capabilities: DocumentCapabilities;
  warning?: string;
} | null {
  const root = relativePath.split("/")[0] ?? "";
  const policy = DOCUMENT_ROOTS.get(root);
  if (!policy) return null;
  const isMarkdown = /\.md$/i.test(relativePath);
  const capabilities: DocumentCapabilities = {
    readable: isMarkdown,
    creatable: policy.writable,
    editable: policy.writable && isMarkdown,
    archivable: policy.writable && isMarkdown,
  };
  return {
    authority: policy.authority,
    capabilities,
    ...(policy.authority === "archive"
      ? { warning: "归档内容不是当前事实来源，必须恢复后才能编辑" }
      : !policy.writable
        ? { warning: "此目录由专用流程维护，普通文档页面只读" }
        : {}),
  };
}

export interface ChapterStatusMetadata {
  status: KnownChapterStatus;
  humanApproved: boolean;
  reviewGate?: string;
  note?: string;
}

export interface ParsedVolumeStatus {
  document?: VolumeStatusDocument;
  issues: RepositoryHealthIssue[];
}

export interface ExpandedStatusRanges {
  statuses: Map<number, ChapterStatusMetadata>;
  issues: RepositoryHealthIssue[];
}

/** 将规范章 ID 转换为正整数；非法 ID 返回 null。 */
export function parseChapterId(value: string): number | null {
  return CHAPTER_ID_PATTERN.test(value) ? Number(value.slice(2)) : null;
}

/** 将正整数格式化为至少三位的全书章 ID。 */
export function formatChapterId(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError("章节编号必须是正整数");
  return `ch${String(value).padStart(3, "0")}`;
}

function statusMetadata(range: StatusRange): ChapterStatusMetadata {
  return {
    status: range.status,
    humanApproved: range.human_approved,
    reviewGate: range.review_gate,
    note: range.note,
  };
}

function sameMetadata(
  left: ChapterStatusMetadata,
  right: ChapterStatusMetadata,
): boolean {
  return (
    left.status === right.status &&
    left.humanApproved === right.humanApproved &&
    left.reviewGate === right.reviewGate &&
    left.note === right.note
  );
}

/** 严格展开状态范围；重叠、逆序和不规范 ID 只诊断，不猜测修复。 */
export function expandStatusRanges(
  ranges: StatusRange[],
  path: string,
  volumeId?: string,
): ExpandedStatusRanges {
  const statuses = new Map<number, ChapterStatusMetadata>();
  const issues: RepositoryHealthIssue[] = [];
  const rangePattern = /^(ch\d+)(?:-(ch\d+))?$/;

  ranges.forEach((range, rangeIndex) => {
    const match = rangePattern.exec(range.chapters);
    const start = match ? parseChapterId(match[1]!) : null;
    const end = match ? parseChapterId(match[2] ?? match[1]!) : null;
    if (start === null || end === null) {
      issues.push({
        code: "INVALID_STATUS_RANGE",
        severity: "blocking",
        message: `状态范围不是规范章 ID：${range.chapters}`,
        path,
        volumeId,
        rangeIndex,
      });
      return;
    }
    if (start > end) {
      issues.push({
        code: "REVERSED_STATUS_RANGE",
        severity: "blocking",
        message: `状态范围起点大于终点：${range.chapters}`,
        path,
        volumeId,
        rangeIndex,
      });
      return;
    }
    if (end - start > 100_000) {
      issues.push({
        code: "STATUS_RANGE_TOO_LARGE",
        severity: "blocking",
        message: `状态范围异常过大：${range.chapters}`,
        path,
        volumeId,
        rangeIndex,
      });
      return;
    }
    if (
      (range.status === "final" && !range.human_approved) ||
      (range.status !== "final" && range.human_approved) ||
      (range.status === "final" && range.review_gate === "pending-human-review")
    ) {
      issues.push({
        code: "INVALID_STATUS_METADATA",
        severity: "blocking",
        message: `章节状态与人工确认元数据冲突：${range.chapters}`,
        path,
        volumeId,
        rangeIndex,
      });
    }
    for (let chapter = start; chapter <= end; chapter += 1) {
      if (statuses.has(chapter)) {
        issues.push({
          code: "OVERLAPPING_STATUS_RANGE",
          severity: "blocking",
          message: `${formatChapterId(chapter)} 被多个状态范围覆盖`,
          path,
          volumeId,
          chapterId: formatChapterId(chapter),
          rangeIndex,
        });
        continue;
      }
      statuses.set(chapter, statusMetadata(range));
    }
  });
  return { statuses, issues };
}

/** 将已验证的逐章状态压缩为稳定、无跨编号空洞的连续范围。 */
export function compactChapterStatuses(
  statuses: ReadonlyMap<number, ChapterStatusMetadata>,
): StatusRange[] {
  const entries = [...statuses.entries()].sort(([a], [b]) => a - b);
  const compacted: StatusRange[] = [];
  let start = 0;
  let end = 0;
  let metadata: ChapterStatusMetadata | undefined;

  const flush = () => {
    if (!metadata) return;
    compacted.push({
      chapters:
        start === end
          ? formatChapterId(start)
          : `${formatChapterId(start)}-${formatChapterId(end)}`,
      status: metadata.status,
      human_approved: metadata.humanApproved,
      ...(metadata.reviewGate ? { review_gate: metadata.reviewGate } : {}),
      ...(metadata.note ? { note: metadata.note } : {}),
    });
  };

  for (const [chapter, current] of entries) {
    if (metadata && chapter === end + 1 && sameMetadata(metadata, current)) {
      end = chapter;
      continue;
    }
    flush();
    start = chapter;
    end = chapter;
    metadata = current;
  }
  flush();
  return compacted;
}

/** 解析并校验卷状态 YAML，返回可展示的稳定健康诊断。 */
export function parseVolumeStatusYaml(
  content: string,
  path: string,
): ParsedVolumeStatus {
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (error) {
    return {
      issues: [
        {
          code: "YAML_PARSE_ERROR",
          severity: "blocking",
          message: "状态 YAML 无法解析",
          path,
          details: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const version =
    raw && typeof raw === "object" && "schema_version" in raw
      ? (raw as { schema_version?: unknown }).schema_version
      : undefined;
  if (version !== 2) {
    return {
      issues: [
        {
          code:
            typeof version === "number" && version > 2
              ? "UNSUPPORTED_SCHEMA_VERSION"
              : "INVALID_STATUS_SCHEMA",
          severity: "blocking",
          message:
            typeof version === "number" && version > 2
              ? `不支持状态 schema 版本 ${version}`
              : "状态文件缺少有效的 schema_version: 2",
          path,
        },
      ],
    };
  }
  const parsed = VolumeStatusDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      issues: [
        {
          code: "INVALID_STATUS_SCHEMA",
          severity: "blocking",
          message: "状态文件结构不符合 schema_version 2",
          path,
          details: parsed.error.issues,
        },
      ],
    };
  }
  return { document: parsed.data, issues: [] };
}
