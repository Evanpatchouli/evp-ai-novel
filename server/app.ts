import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import serve from "koa-static";
import { z } from "zod";
import type {
  ApiResult,
  RepositoryHealthIssue,
  VolumeIndexData,
  VolumeRelatedRecord,
} from "../shared/contracts.js";
import { NovelLibrary } from "./novel-library.js";
import { browserAutomation } from "./automation.js";
import {
  commitChapterMutation,
  getChapterCreateDefaults,
  hasPendingChapterMutation,
  listChapterArchives,
  prepareChapterArchive,
  prepareChapterDelete,
  prepareChapterCreate,
  prepareChapterEdit,
  prepareChapterRestore,
} from "./chapter-mutations.js";
import { AppError } from "./errors.js";
import {
  commitDocumentMutation,
  hasPendingDocumentMutation,
  listDocumentArchives,
  prepareDocumentArchive,
  prepareDocumentCreate,
  prepareDocumentEdit,
  prepareDocumentRestore,
} from "./document-mutations.js";
import { readUtf8, relativeSlash, resolveInside } from "./files.js";
import { createNovelVersion, getGitStatus, listNovelVersions } from "./git.js";
import {
  assertRepositoryWritable,
  invalidateMutationPreviews,
  recoverMutationRepository,
  type RecoveryResult,
} from "./mutations/index.js";
import {
  commitNovelMetadataMutation,
  hasPendingNovelMetadataMutation,
  prepareNovelMetadata,
  readNovelMetadata,
} from "./novel-metadata.js";
import {
  createRequestSecurityMiddleware,
  createSessionTokenManager,
  type RequestSecurityOptions,
} from "./request-security.js";
import {
  getDashboard,
  invalidateRepositoryReadModel,
  readChapterDetail,
  readDocument,
  readDocumentTree,
  readRepositoryIndex,
  readVolumeDetail,
  searchDocuments,
  validateRepository,
} from "./repository.js";
import {
  ChapterIdSchema,
  NovelCoverUploadSchema,
  VolumeIdSchema,
} from "./repository-domain.js";
import { openExternal } from "./system.js";
import {
  archiveTask,
  buildCompactRevisionPackage,
  buildCompactTextRevisionPackage,
  buildContextPackage,
  buildRevisionPackage,
  commitWrite,
  completeHumanFinal,
  confirmFinal,
  contextCandidates,
  createTask,
  getIssues,
  getTask,
  importReview,
  importRevision,
  listTasks,
  previewWrite,
  recordDecisions,
  rewindTaskStage,
  saveHumanFinal,
} from "./tasks.js";
import {
  commitVolumeMutation,
  getVolumeCreateDefaults,
  hasPendingVolumeMutation,
  listVolumeArchives,
  prepareVolumeArchive,
  prepareVolumeCreate,
  prepareVolumeDelete,
  prepareVolumeRename,
  prepareVolumeRestore,
} from "./volume-mutations.js";

const stringBody = z.object({ content: z.string() });
const taskParams = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\w-]+$/),
});

/** 创建可测试的 Koa 应用。 */
export function createApp(
  initialRoot?: string,
  options: { requestSecurity?: RequestSecurityOptions; dataRoot?: string } = {},
): Koa {
  const app = new Koa();
  const router = new Router({ prefix: "/api" });
  const sessionTokens =
    options.requestSecurity?.sessionTokens ?? createSessionTokenManager();
  const library = new NovelLibrary(options.dataRoot);
  let selectedId: string | undefined;
  let repositoryRoot = initialRoot ? path.resolve(initialRoot) : "";
  let activeApiRequests = 0;
  let deletingNovel = false;
  let initialRecovery: Promise<RecoveryResult | Error> = (async () => {
    if (!initialRoot) {
      await library.ensure();
      selectedId = await library.selected();
      if (selectedId) repositoryRoot = await library.resolve(selectedId);
    }
    if (!repositoryRoot) return { recovered: [], cleaned: [], recoveryRequired: [] };
    return recoverMutationRepository(repositoryRoot);
  })().catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));

  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        ctx.status = 400;
        ctx.body = {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "请求参数无效",
            details: error.issues,
          },
        } satisfies ApiResult<never>;
        return;
      }
      const known = error instanceof AppError;
      ctx.status = known ? error.status : 500;
      ctx.body = {
        ok: false,
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "服务器内部错误",
          details: known ? error.details : undefined,
        },
      } satisfies ApiResult<never>;
      if (!known) app.emit("error", error, ctx);
    }
  });
  app.use(async (_ctx, next) => {
    await initialRecovery;
    await next();
  });
  app.use(
    createRequestSecurityMiddleware({
      ...options.requestSecurity,
      sessionTokens,
    }),
  );
  app.use(bodyParser({ jsonLimit: "10mb", textLimit: "10mb" }));
  app.use(async (ctx, next) => {
    if (!ctx.path.startsWith("/api/") || ctx.path === "/api/health") return next();
    if (deletingNovel) throw new AppError("NOVEL_LIBRARY_BUSY", "小说正在删除，请稍后重试", 409);
    const libraryRequest = ["/api/novels", "/api/novels/select", "/api/repository/select"].includes(ctx.path) ||
      (ctx.method === "DELETE" && /^\/api\/novels\/[^/]+\/?$/.test(ctx.path));
    if (!repositoryRoot && !libraryRequest) {
      throw new AppError("NO_NOVEL_SELECTED", "请先新建或选择小说", 404);
    }
    activeApiRequests++;
    try {
      await next();
    } finally {
      activeApiRequests--;
    }
  });

  const taskDetail = async (id: string) => {
    const task = await getTask(repositoryRoot, id);
    const directory = resolveInside(repositoryRoot, task.directory);
    const optional = async (name: string) =>
      readUtf8(path.join(directory, name)).catch(() => undefined);
    const chapter = await readChapterDetail(
      repositoryRoot,
      task.volumeId,
      task.chapterId,
    ).catch((error: unknown) => {
      if (error instanceof AppError && error.code === "CHAPTER_NOT_FOUND")
        return undefined;
      throw error;
    });
    const analysisRaw = await optional("05_修订分析.json");
    return {
      ...task,
      chapter,
      reviewRaw: await optional("03_审稿报告_原文.md"),
      issues: await getIssues(repositoryRoot, id),
      revisionRaw:
        (await optional("06_人工终审稿.md")) ??
        (await optional("05_AI修订稿.md")),
      revisionAnalysis: analysisRaw ? JSON.parse(analysisRaw) : undefined,
      context: await contextCandidates(repositoryRoot, id),
      prompt:
        (await optional("04_修订提示词.md")) ??
        (await optional("02_审查提示词.md")),
    };
  };

  const mutationHealthIssue = async (): Promise<
    RepositoryHealthIssue | undefined
  > => {
    try {
      await assertRepositoryWritable(repositoryRoot);
      return undefined;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === "MUTATION_RECOVERY_REQUIRED") {
        return {
          code: error.code,
          severity: "blocking",
          message: error.message,
          path: ".workbench/",
        };
      }
      if (error.code === "REPOSITORY_LOCKED") {
        return {
          code: error.code,
          severity: "warning",
          message: error.message,
          path: ".workbench/write.lock",
        };
      }
      throw error;
    }
  };

  router.get("/health", async (ctx) => {
    const recovery = await initialRecovery;
    ctx.body = {
      ok: true,
      data: {
        status: "ok",
        ready: true,
        sessionToken: sessionTokens.current(),
        recoveryRequired:
          recovery instanceof Error ||
          ("recoveryRequired" in recovery &&
            recovery.recoveryRequired.length > 0),
      },
    };
  });
  router.get("/novels", async (ctx) => {
    ctx.body = { ok: true, data: { novels: await library.list(), selectedId: selectedId ?? null } };
  });
  router.post("/novels", async (ctx) => {
    const { title, author, description } = z.object({ title: z.string().trim().min(1).max(120).regex(/^[^\r\n]+$/), author: z.string().trim().min(1).max(120).regex(/^[^\r\n]+$/), description: z.string().max(20_000).default("") }).strict().parse(ctx.request.body);
    const novel = await library.create(title, author, description);
    ctx.body = { ok: true, data: novel };
  });
  router.delete("/novels/:id", async (ctx) => {
    const { id } = z.object({ id: z.string() }).parse(ctx.params);
    z.object({ confirmed: z.literal(true) }).strict().parse(ctx.request.body);
    if (activeApiRequests > 1) throw new AppError("NOVEL_LIBRARY_BUSY", "工作台仍有操作正在进行，请稍后重试", 409);
    deletingNovel = true;
    try {
      const root = await library.resolve(id);
      const novels = await library.list();
      if (!novels.some((novel) => novel.id === id)) throw new AppError("NOVEL_NOT_FOUND", "小说不在工作台书库中", 404);
      const remaining = novels.filter((novel) => novel.id !== id);
      const deletingSelected = selectedId === id || repositoryRoot === root;
      const nextId = deletingSelected ? remaining[0]?.id : selectedId;
      const nextRoot = deletingSelected && nextId ? await library.resolve(nextId) : "";

      await invalidateMutationPreviews(root);
      invalidateRepositoryReadModel(root);
      const remainingPath = await library.remove(id);
      if (deletingSelected) {
        selectedId = nextId;
        repositoryRoot = nextRoot;
        initialRecovery = nextRoot
          ? recoverMutationRepository(nextRoot).catch((error: Error) => error)
          : Promise.resolve({ recovered: [], cleaned: [], recoveryRequired: [] });
        sessionTokens.rotate();
        await library.saveSelection(nextId).catch((error: Error) => app.emit("error", error, ctx));
      }
      ctx.body = { ok: true, data: { novels: remaining, selectedId: selectedId ?? null, sessionToken: sessionTokens.current(), remainingPath } };
    } finally {
      deletingNovel = false;
    }
  });
  router.post("/novels/select", async (ctx) => {
    const { id } = z.object({ id: z.string() }).strict().parse(ctx.request.body);
    const candidateRoot = await library.resolve(id);
    const recovery = await recoverMutationRepository(candidateRoot);
    if (recovery.recoveryRequired.length) throw new AppError("MUTATION_RECOVERY_REQUIRED", "小说存在需要人工恢复的事务", 503, recovery);
    const previousRoot = repositoryRoot;
    await library.select(id);
    if (previousRoot) {
      await invalidateMutationPreviews(previousRoot);
      invalidateRepositoryReadModel(previousRoot);
    }
    selectedId = id;
    repositoryRoot = candidateRoot;
    initialRecovery = Promise.resolve(recovery);
    sessionTokens.rotate();
    ctx.body = { ok: true, data: { id, sessionToken: sessionTokens.current() } };
  });
  router.post("/repository/select", async (ctx) => {
    if (!initialRoot) throw new AppError("EXTERNAL_REPOSITORY_DISABLED", "应用只管理自己的小说", 403);
    const body = z
      .object({
        path: z.string().min(1).optional(),
        root: z.string().min(1).optional(),
      })
      .refine((value) => value.path || value.root)
      .parse(ctx.request.body);
    const candidateRoot = await validateRepository(body.path ?? body.root!);
    const recovery = await recoverMutationRepository(candidateRoot);
    if (recovery.recoveryRequired.length > 0) {
      throw new AppError(
        "MUTATION_RECOVERY_REQUIRED",
        "候选仓库存在需要人工恢复的事务",
        503,
        recovery,
      );
    }
    const previousRoot = repositoryRoot;
    await invalidateMutationPreviews(previousRoot);
    repositoryRoot = candidateRoot;
    initialRecovery = Promise.resolve(recovery);
    invalidateRepositoryReadModel(previousRoot);
    sessionTokens.rotate();
    ctx.body = {
      ok: true,
      data: {
        repositoryRoot,
        root: repositoryRoot,
        projectName: path.basename(repositoryRoot),
        sessionToken: sessionTokens.current(),
      },
    };
  });
  router.get("/repository", async (ctx) => {
    repositoryRoot = await validateRepository(repositoryRoot);
    ctx.body = {
      ok: true,
      data: {
        repositoryRoot,
        root: repositoryRoot,
        projectName: path.basename(repositoryRoot),
        sessionToken: sessionTokens.current(),
      },
    };
  });
  router.get("/dashboard", async (ctx) => {
    if (!repositoryRoot) throw new AppError("NO_NOVEL_SELECTED", "请先新建或选择小说", 404);
    repositoryRoot = await validateRepository(repositoryRoot);
    const current = (await listTasks(repositoryRoot)).find(
      (task) => task.stage !== "archived",
    );
    const dashboard = await getDashboard(repositoryRoot, current);
    if (selectedId) dashboard.projectName = (await readNovelMetadata(repositoryRoot)).metadata.novel.title;
    const mutationIssue = await mutationHealthIssue();
    if (mutationIssue) {
      dashboard.health.issues.push(mutationIssue);
      dashboard.health.healthy =
        dashboard.health.healthy && mutationIssue.severity !== "blocking";
    }
    ctx.body = { ok: true, data: dashboard };
  });
  router.get("/repository/health", async (ctx) => {
    const health = (await readRepositoryIndex(repositoryRoot)).health;
    const mutationIssue = await mutationHealthIssue();
    if (mutationIssue) {
      health.issues.push(mutationIssue);
      health.healthy = health.healthy && mutationIssue.severity !== "blocking";
    }
    ctx.body = {
      ok: true,
      data: health,
    };
  });
  router.get("/volumes", async (ctx) => {
    const [index, tasks] = await Promise.all([
      readRepositoryIndex(repositoryRoot),
      listTasks(repositoryRoot),
    ]);
    const mutationIssue = await mutationHealthIssue();
    if (mutationIssue) {
      index.health.issues.push(mutationIssue);
      index.health.healthy =
        index.health.healthy && mutationIssue.severity !== "blocking";
    }
    const current = tasks.find((task) => task.stage !== "archived");
    ctx.body = {
      ok: true,
      data: {
        volumes: index.volumes,
        health: index.health,
        currentVolumeId: current?.volumeId,
        currentChapterId: current?.chapterId,
      } satisfies VolumeIndexData,
    };
  });
  router.get("/volumes/new", async (ctx) => {
    ctx.body = {
      ok: true,
      data: await getVolumeCreateDefaults(repositoryRoot),
    };
  });
  router.post("/volumes/preview", async (ctx) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(120) })
      .strict()
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await prepareVolumeCreate(repositoryRoot, body),
    };
  });
  router.put("/volumes/:volumeId/preview", async (ctx) => {
    const { volumeId } = z
      .object({ volumeId: VolumeIdSchema })
      .parse(ctx.params);
    const body = z
      .object({ title: z.string().trim().min(1).max(120) })
      .strict()
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await prepareVolumeRename(repositoryRoot, { volumeId, ...body }),
    };
  });
  router.post("/volumes/:volumeId/archive/preview", async (ctx) => {
    const { volumeId } = z
      .object({ volumeId: VolumeIdSchema })
      .parse(ctx.params);
    const body = z
      .object({ reason: z.string().trim().min(1).max(500) })
      .strict()
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await prepareVolumeArchive(repositoryRoot, { volumeId, ...body }),
    };
  });
  router.get("/archives/volumes", async (ctx) => {
    ctx.body = { ok: true, data: await listVolumeArchives(repositoryRoot) };
  });
  router.post("/volumes/:volumeId/delete/preview", async (ctx) => {
    const { volumeId } = z.object({ volumeId: VolumeIdSchema }).parse(ctx.params);
    ctx.body = { ok: true, data: await prepareVolumeDelete(repositoryRoot, volumeId) };
  });
  router.post("/archives/volumes/:archiveId/restore/preview", async (ctx) => {
    const { archiveId } = z
      .object({ archiveId: z.string().min(1).max(100) })
      .parse(ctx.params);
    ctx.body = {
      ok: true,
      data: await prepareVolumeRestore(repositoryRoot, { archiveId }),
    };
  });
  router.get("/volumes/:volumeId", async (ctx) => {
    const { volumeId } = z
      .object({ volumeId: VolumeIdSchema })
      .parse(ctx.params);
    const tasks = await listTasks(repositoryRoot);
    const current = tasks.find(
      (task) => task.stage !== "archived" && task.volumeId === volumeId,
    );
    const detail = await readVolumeDetail(
      repositoryRoot,
      volumeId,
      current?.chapterId,
    );
    const productionRecords = tasks.flatMap((task): VolumeRelatedRecord[] => {
      if (task.stage === "archived" || task.volumeId !== volumeId) return [];
      try {
        const absolute = resolveInside(
          repositoryRoot,
          path.posix.join(task.directory, "task.yaml"),
        );
        const relative = relativeSlash(repositoryRoot, absolute);
        if (!relative.startsWith("30_生产/active/")) return [];
        return [
          {
            kind: "production",
            path: relative,
            title: `${task.chapterId} 修订任务`,
          },
        ];
      } catch {
        return [];
      }
    });
    ctx.body = {
      ok: true,
      data: {
        ...detail,
        relatedRecords: [...detail.relatedRecords, ...productionRecords],
      },
    };
  });
  router.get("/volumes/:volumeId/chapters/new", async (ctx) => {
    const { volumeId } = z
      .object({ volumeId: VolumeIdSchema })
      .parse(ctx.params);
    ctx.body = {
      ok: true,
      data: await getChapterCreateDefaults(repositoryRoot, volumeId),
    };
  });
  router.get("/volumes/:volumeId/chapters/:chapterId", async (ctx) => {
    const params = z
      .object({
        volumeId: VolumeIdSchema,
        chapterId: ChapterIdSchema,
      })
      .parse(ctx.params);
    ctx.body = {
      ok: true,
      data: await readChapterDetail(
        repositoryRoot,
        params.volumeId,
        params.chapterId,
      ),
    };
  });
  router.post("/volumes/:volumeId/chapters/preview", async (ctx) => {
    const { volumeId } = z
      .object({ volumeId: VolumeIdSchema })
      .parse(ctx.params);
    const body = stringBody.parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await prepareChapterCreate(repositoryRoot, {
        volumeId,
        content: body.content,
      }),
    };
  });
  router.put("/volumes/:volumeId/chapters/:chapterId/preview", async (ctx) => {
    const params = z
      .object({
        volumeId: VolumeIdSchema,
        chapterId: ChapterIdSchema,
      })
      .parse(ctx.params);
    const body = z
      .object({ content: z.string(), expectedHash: z.string().length(64) })
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await prepareChapterEdit(repositoryRoot, { ...params, ...body }),
    };
  });
  router.post(
    "/volumes/:volumeId/chapters/:chapterId/archive/preview",
    async (ctx) => {
      const params = z
        .object({
          volumeId: VolumeIdSchema,
          chapterId: ChapterIdSchema,
        })
        .parse(ctx.params);
      const body = z
        .object({
          reason: z.string().trim().min(1).max(500),
          expectedHash: z.string().length(64),
          confirmFinal: z.boolean().default(false),
        })
        .parse(ctx.request.body);
      ctx.body = {
        ok: true,
        data: await prepareChapterArchive(repositoryRoot, {
          ...params,
          ...body,
        }),
      };
    },
  );
  router.get("/archives/chapters", async (ctx) => {
    ctx.body = {
      ok: true,
      data: await listChapterArchives(repositoryRoot),
    };
  });
  router.post("/volumes/:volumeId/chapters/:chapterId/delete/preview", async (ctx) => {
    const params = z.object({ volumeId: VolumeIdSchema, chapterId: ChapterIdSchema }).parse(ctx.params);
    const body = z.object({ expectedHash: z.string().length(64) }).strict().parse(ctx.request.body);
    ctx.body = { ok: true, data: await prepareChapterDelete(repositoryRoot, { ...params, ...body }) };
  });
  router.post("/archives/chapters/:archiveId/restore/preview", async (ctx) => {
    const { archiveId } = z
      .object({ archiveId: z.string().min(1).max(100) })
      .parse(ctx.params);
    ctx.body = {
      ok: true,
      data: await prepareChapterRestore(repositoryRoot, { archiveId }),
    };
  });
  router.post("/mutations/:token/commit", async (ctx) => {
    const { token } = z.object({ token: z.string().uuid() }).parse(ctx.params);
    const body = z
      .object({
        confirmed: z.literal(true),
        confirmationKeys: z.array(z.string()).max(20),
      })
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: hasPendingChapterMutation(token)
        ? await commitChapterMutation(
            repositoryRoot,
            token,
            body.confirmationKeys,
          )
        : hasPendingVolumeMutation(token)
          ? await commitVolumeMutation(
              repositoryRoot,
              token,
              body.confirmationKeys,
            )
          : hasPendingDocumentMutation(token)
            ? await commitDocumentMutation(
                repositoryRoot,
                token,
                body.confirmationKeys,
              )
            : hasPendingNovelMetadataMutation(token)
              ? await commitNovelMetadataMutation(
                  repositoryRoot,
                  token,
                  body.confirmationKeys,
                )
              : await commitChapterMutation(
                  repositoryRoot,
                  token,
                  body.confirmationKeys,
                ),
    };
  });
  router.get("/documents/tree", async (ctx) => {
    ctx.body = { ok: true, data: await readDocumentTree(repositoryRoot) };
  });
  router.get("/documents/search", async (ctx) => {
    const query = z
      .object({
        q: z.string(),
        limit: z.coerce.number().int().min(1).max(200).default(80),
      })
      .parse(ctx.query);
    ctx.body = {
      ok: true,
      data: await searchDocuments(repositoryRoot, query.q, query.limit),
    };
  });
  router.get("/documents/content", async (ctx) => {
    const query = z.object({ path: z.string() }).parse(ctx.query);
    ctx.body = {
      ok: true,
      data: await readDocument(repositoryRoot, query.path),
    };
  });
  router.post("/documents/preview", async (ctx) => {
    const body = z
      .object({ path: z.string().min(1).max(500), content: z.string() })
      .strict()
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await prepareDocumentCreate(repositoryRoot, body),
    };
  });
  router.put("/documents/preview", async (ctx) => {
    const body = z
      .object({
        path: z.string().min(1).max(500),
        content: z.string(),
        expectedHash: z.string().length(64),
      })
      .strict()
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await prepareDocumentEdit(repositoryRoot, body),
    };
  });
  router.post("/documents/archive/preview", async (ctx) => {
    const body = z
      .object({
        path: z.string().min(1).max(500),
        reason: z.string().trim().min(1).max(500),
        expectedHash: z.string().length(64),
      })
      .strict()
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await prepareDocumentArchive(repositoryRoot, body),
    };
  });
  router.get("/archives/documents", async (ctx) => {
    ctx.body = { ok: true, data: await listDocumentArchives(repositoryRoot) };
  });
  router.post("/archives/documents/:archiveId/restore/preview", async (ctx) => {
    const { archiveId } = z
      .object({ archiveId: z.string().min(1).max(100) })
      .parse(ctx.params);
    ctx.body = {
      ok: true,
      data: await prepareDocumentRestore(repositoryRoot, { archiveId }),
    };
  });
  router.get("/novel", async (ctx) => {
    ctx.body = { ok: true, data: await readNovelMetadata(repositoryRoot) };
  });
  router.put("/novel/preview", async (ctx) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(120),
        author: z.string().max(120),
        description: z.string().max(20_000),
        coverUpload: NovelCoverUploadSchema.optional(),
        currentVolume: VolumeIdSchema.optional(),
        currentChapter: ChapterIdSchema.optional(),
        expectedHash: z.string().length(64).optional(),
      })
      .strict()
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await prepareNovelMetadata(repositoryRoot, body),
    };
  });
  router.get("/documents", async (ctx) => {
    const query = z.object({ query: z.string() }).parse(ctx.query);
    const documents = await searchDocuments(repositoryRoot, query.query);
    ctx.body = {
      ok: true,
      data: documents.map(
        ({ label, selected: _selected, reason: _reason, ...item }) => ({
          ...item,
          title: label,
        }),
      ),
    };
  });
  router.post("/open", async (ctx) => {
    const body = z
      .object({
        path: z.string(),
        target: z.enum(["default", "folder"]).default("default"),
      })
      .parse(ctx.request.body);
    await openExternal(repositoryRoot, body.path, body.target);
    ctx.body = { ok: true, data: null };
  });
  router.post("/system/open", async (ctx) => {
    const body = z
      .object({
        path: z.string(),
        target: z.enum(["default", "folder"]).default("default"),
      })
      .parse(ctx.request.body);
    await openExternal(repositoryRoot, body.path, body.target);
    ctx.body = { ok: true, data: { opened: true } };
  });
  router.get("/git/versions", async (ctx) => {
    ctx.body = { ok: true, data: await listNovelVersions(repositoryRoot) };
  });
  router.post("/git/versions", async (ctx) => {
    const { message } = z.object({ message: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/) }).strict().parse(ctx.request.body);
    ctx.body = { ok: true, data: await createNovelVersion(repositoryRoot, message) };
  });
  router.get("/git/status", async (ctx) => {
    ctx.body = { ok: true, data: await getGitStatus(repositoryRoot) };
  });
  router.get("/automation/capabilities", (ctx) => {
    ctx.body = { ok: true, data: browserAutomation.capabilities() };
  });

  router.get("/tasks", async (ctx) => {
    ctx.body = { ok: true, data: await listTasks(repositoryRoot) };
  });
  router.post("/tasks", async (ctx) => {
    const body = z
      .object({
        volumeId: z.string(),
        chapterId: z.string(),
        allowFinalRevision: z.boolean().default(false),
      })
      .parse(ctx.request.body);
    ctx.status = 201;
    ctx.body = {
      ok: true,
      data: await createTask(
        repositoryRoot,
        body.volumeId,
        body.chapterId,
        body.allowFinalRevision,
      ),
    };
  });
  router.get("/tasks/:id", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    ctx.body = { ok: true, data: await taskDetail(id) };
  });
  router.get("/tasks/:id/context", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    ctx.body = {
      ok: true,
      data: { candidates: await contextCandidates(repositoryRoot, id) },
    };
  });
  router.post("/tasks/:id/context-package", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = z
      .object({ paths: z.array(z.string()).min(1) })
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await buildContextPackage(repositoryRoot, id, body.paths),
    };
  });
  router.post("/tasks/:id/context/build", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = z
      .object({ selectedPaths: z.array(z.string()).min(1) })
      .parse(ctx.request.body);
    const built = await buildContextPackage(
      repositoryRoot,
      id,
      body.selectedPaths,
    );
    ctx.body = {
      ok: true,
      data: {
        candidates: await contextCandidates(repositoryRoot, id),
        prompt: built.prompt,
        packagePath: built.zipPath,
      },
    };
  });
  router.get("/tasks/:id/context-package/download", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const task = await getTask(repositoryRoot, id);
    const file = resolveInside(
      repositoryRoot,
      path.posix.join(task.directory, "02_ChatGPT审查上下文.zip"),
    );
    ctx.attachment(`${id}-context.zip`);
    ctx.type = "application/zip";
    ctx.body = createReadStream(file);
  });
  router.post("/tasks/:id/revision-package", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    ctx.body = {
      ok: true,
      data: await buildRevisionPackage(repositoryRoot, id),
    };
  });
  router.get("/tasks/:id/revision-package/download", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const task = await getTask(repositoryRoot, id);
    const file = resolveInside(
      repositoryRoot,
      path.posix.join(task.directory, "04_AI修订上下文.zip"),
    );
    try {
      await access(file);
    } catch {
      throw new AppError(
        "REVISION_PACKAGE_NOT_FOUND",
        "尚未生成修订任务包",
        404,
      );
    }
    ctx.attachment(`${id}-revision-context.zip`);
    ctx.type = "application/zip";
    ctx.body = createReadStream(file);
  });
  router.post("/tasks/:id/revision-package/compact", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    ctx.body = {
      ok: true,
      data: await buildCompactRevisionPackage(repositoryRoot, id),
    };
  });
  router.get("/tasks/:id/revision-package/compact/download", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const task = await getTask(repositoryRoot, id);
    const file = resolveInside(
      repositoryRoot,
      path.posix.join(task.directory, "04_AI修订精简包.zip"),
    );
    try {
      await access(file);
    } catch {
      throw new AppError(
        "COMPACT_REVISION_PACKAGE_NOT_FOUND",
        "尚未生成精简修订包",
        404,
      );
    }
    ctx.attachment(`${id}-compact-revision-context.zip`);
    ctx.type = "application/zip";
    ctx.body = createReadStream(file);
  });
  router.post("/tasks/:id/revision-package/compact-text", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    ctx.body = {
      ok: true,
      data: await buildCompactTextRevisionPackage(repositoryRoot, id),
    };
  });
  router.get(
    "/tasks/:id/revision-package/compact-text/download",
    async (ctx) => {
      const { id } = taskParams.parse(ctx.params);
      const task = await getTask(repositoryRoot, id);
      const file = resolveInside(
        repositoryRoot,
        path.posix.join(task.directory, "04_AI修订精简单文件.txt"),
      );
      try {
        await access(file);
      } catch {
        throw new AppError(
          "COMPACT_TEXT_REVISION_PACKAGE_NOT_FOUND",
          "尚未生成单文件修订包",
          404,
        );
      }
      ctx.attachment(`${id}-compact-revision-context.txt`);
      ctx.type = "text/plain; charset=utf-8";
      ctx.body = createReadStream(file);
    },
  );
  router.post("/tasks/:id/review", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = stringBody.parse(ctx.request.body);
    await importReview(repositoryRoot, id, body.content);
    ctx.body = { ok: true, data: await taskDetail(id) };
  });
  router.get("/tasks/:id/issues", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    ctx.body = { ok: true, data: await getIssues(repositoryRoot, id) };
  });
  router.put("/tasks/:id/decisions", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = z
      .object({
        decisions: z.array(
          z.object({
            id: z.string(),
            decision: z.enum([
              "approved",
              "partially-approved",
              "rejected",
              "later",
            ]),
            note: z.string().optional(),
            decisionNote: z.string().optional(),
          }),
        ),
        revisionInstructionAdditions: z
          .array(z.string().trim().min(1).max(1_000))
          .max(10)
          .default([]),
      })
      .parse(ctx.request.body);
    await recordDecisions(
      repositoryRoot,
      id,
      body.decisions.map((item) => ({
        id: item.id,
        decision: item.decision,
        note: item.note ?? item.decisionNote,
      })),
      body.revisionInstructionAdditions,
    );
    ctx.body = { ok: true, data: await taskDetail(id) };
  });
  router.post("/tasks/:id/revision", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = stringBody.parse(ctx.request.body);
    await importRevision(repositoryRoot, id, body.content);
    ctx.body = { ok: true, data: await taskDetail(id) };
  });
  router.put("/tasks/:id/human-final", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = stringBody.parse(ctx.request.body);
    await saveHumanFinal(repositoryRoot, id, body.content);
    ctx.body = { ok: true, data: await taskDetail(id) };
  });
  router.post("/tasks/:id/final-confirmation", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = z
      .object({
        fullyRead: z.boolean(),
        plotAndCharacterApproved: z.boolean(),
        noUnauthorizedCanon: z.boolean(),
        continuityApproved: z.boolean(),
        willingToFinalize: z.boolean(),
      })
      .parse(ctx.request.body);
    await confirmFinal(repositoryRoot, id, body);
    ctx.body = { ok: true, data: await taskDetail(id) };
  });
  router.post("/tasks/:id/final-review", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = z
      .object({
        confirmation: z.object({
          fullyRead: z.boolean(),
          plotAndCharacterApproved: z.boolean(),
          noUnauthorizedCanon: z.boolean(),
          continuityApproved: z.boolean(),
          willingToFinalize: z.boolean(),
        }),
        content: z.string().optional(),
      })
      .parse(ctx.request.body);
    const task = await getTask(repositoryRoot, id);
    const content =
      body.content ??
      (await readUtf8(
        path.join(
          resolveInside(repositoryRoot, task.directory),
          "05_AI修订稿.md",
        ),
      ));
    await completeHumanFinal(repositoryRoot, id, content, body.confirmation);
    ctx.body = { ok: true, data: await taskDetail(id) };
  });
  router.post("/tasks/:id/write-preview", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    ctx.body = { ok: true, data: await previewWrite(repositoryRoot, id) };
  });
  router.post("/tasks/:id/write/preview", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    ctx.body = { ok: true, data: await previewWrite(repositoryRoot, id) };
  });
  router.post("/tasks/:id/write-confirm", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = z
      .object({ token: z.string().uuid(), confirmed: z.literal(true) })
      .parse(ctx.request.body);
    ctx.body = {
      ok: true,
      data: await commitWrite(repositoryRoot, id, body.token, body.confirmed),
    };
  });
  router.post("/tasks/:id/write/commit", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = z.object({ token: z.string().uuid() }).parse(ctx.request.body);
    await commitWrite(repositoryRoot, id, body.token, true);
    ctx.body = { ok: true, data: await taskDetail(id) };
  });
  router.put("/tasks/:id/stage", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    const body = z
      .object({
        stage: z.enum([
          "created",
          "context-ready",
          "review-imported",
          "decisions-recorded",
          "revision-imported",
          "human-final-review",
          "ready-to-write",
          "written",
          "archived",
        ]),
      })
      .parse(ctx.request.body);
    await rewindTaskStage(repositoryRoot, id, body.stage);
    ctx.body = { ok: true, data: await taskDetail(id) };
  });
  router.post("/tasks/:id/archive", async (ctx) => {
    const { id } = taskParams.parse(ctx.params);
    ctx.body = { ok: true, data: await archiveTask(repositoryRoot, id) };
  });

  app.use(router.routes()).use(router.allowedMethods());
  const clientDist = path.resolve(import.meta.dirname, "..", "client");
  app.use(serve(clientDist));
  app.use(async (ctx) => {
    if (
      ctx.method !== "GET" ||
      ctx.path.startsWith("/api") ||
      path.extname(ctx.path)
    )
      return;
    ctx.type = "html";
    ctx.body = createReadStream(path.join(clientDist, "index.html"));
  });
  return app;
}
