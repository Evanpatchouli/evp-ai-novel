import type {
  ApiResult,
  AutomationCapabilities,
  ChapterArchiveEntry,
  ChapterCreateDefaults,
  ChapterDetail,
  ChapterMutationCommitResult,
  ChapterMutationPreview,
  ContextCandidate,
  DashboardData,
  DecisionStatus,
  DocumentArchiveEntry,
  DocumentDetail,
  DocumentMutationCommitResult,
  DocumentMutationPreview,
  DocumentTreeNode,
  FinalConfirmation,
  GitStatusSummary,
  NovelMetadataCommitResult,
  NovelMetadataDetail,
  NovelMetadataPreview,
  ProductionTaskSummary,
  RepositoryHealth,
  ReviewIssue,
  RevisionAnalysis,
  TaskStage,
  VolumeArchiveEntry,
  VolumeCreateDefaults,
  VolumeDetail,
  VolumeIndexData,
  VolumeMutationCommitResult,
  VolumeMutationPreview,
  WritePreview,
} from "../../shared/contracts";

export interface TaskDetail extends ProductionTaskSummary {
  chapter?: ChapterDetail;
  context?: ContextCandidate[];
  reviewRaw?: string;
  issues?: ReviewIssue[];
  revisionRaw?: string;
  revisionAnalysis?: RevisionAnalysis;
  finalConfirmation?: FinalConfirmation;
  prompt?: string;
}

export interface ContextResponse {
  candidates: ContextCandidate[];
  prompt?: string;
  packagePath?: string;
}

export interface DocumentSearchResult {
  path: string;
  title: string;
  authority: ContextCandidate["authority"];
  excerpt?: string;
  warning?: string;
}

export interface NovelMetadataValues {
  title: string;
  author: string;
  description: string;
  currentVolume?: string;
  currentChapter?: string;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export interface NovelVersion { id: string; date: string; message: string }

export interface ManagedNovel { id: string; title: string }

export interface RepositoryInfo {
  root: string;
  projectName?: string;
  sessionToken?: string;
}

let workbenchSessionToken: string | undefined;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function loadSessionToken(): Promise<string> {
  const response = await fetch("/api/health", {
    headers: { "Content-Type": "application/json" },
  });
  const result = (await response.json()) as ApiResult<{
    ready: boolean;
    sessionToken: string;
  }>;
  if (!response.ok || !result.ok || !result.data?.sessionToken) {
    throw new Error(result.error?.message ?? "无法建立工作台安全会话");
  }
  workbenchSessionToken = result.data.sessionToken;
  return workbenchSessionToken;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const requiresSession = !["GET", "HEAD", "OPTIONS"].includes(method);
  const sessionToken = requiresSession
    ? (workbenchSessionToken ?? (await loadSessionToken()))
    : undefined;
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { "X-Workbench-Session": sessionToken } : undefined),
      ...init?.headers,
    },
  });
  let result: ApiResult<T>;
  try {
    result = (await response.json()) as ApiResult<T>;
  } catch {
    throw new Error(`服务返回了无法识别的响应（HTTP ${response.status}）`);
  }
  if (!response.ok || !result.ok || result.data === undefined) {
    throw new ApiRequestError(
      result.error?.message ?? `请求失败（HTTP ${response.status}）`,
      result.error?.code ?? "REQUEST_FAILED",
      response.status,
      result.error?.details,
    );
  }
  if (
    typeof result.data === "object" &&
    result.data !== null &&
    "sessionToken" in result.data &&
    typeof result.data.sessionToken === "string"
  ) {
    workbenchSessionToken = result.data.sessionToken;
  }
  return result.data;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  health: () =>
    request<{ ready: boolean; sessionToken: string }>("/api/health"),
  novels: () => request<{ novels: ManagedNovel[]; selectedId: string | null }>("/api/novels"),
  createNovel: (title: string, author: string, description: string) => request<ManagedNovel>("/api/novels", json("POST", { title, author, description })),
  selectNovel: (id: string) => request<{ id: string; sessionToken: string }>("/api/novels/select", json("POST", { id })),
  deleteNovel: (id: string) => request<{ novels: ManagedNovel[]; selectedId: string | null; sessionToken: string; remainingPath?: string }>(
    `/api/novels/${encodeURIComponent(id)}`, json("DELETE", { confirmed: true }),
  ),
  repository: () => request<RepositoryInfo>("/api/repository"),
  dashboard: () => request<DashboardData>("/api/dashboard"),
  repositoryHealth: () => request<RepositoryHealth>("/api/repository/health"),
  volumes: () => request<VolumeIndexData>("/api/volumes"),
  volume: (volumeId: string) =>
    request<VolumeDetail>(`/api/volumes/${encodeURIComponent(volumeId)}`),
  volumeCreateDefaults: () => request<VolumeCreateDefaults>("/api/volumes/new"),
  previewVolumeDelete: (volumeId: string) => request<VolumeMutationPreview>(
    `/api/volumes/${encodeURIComponent(volumeId)}/delete/preview`, json("POST"),
  ),
  previewVolumeCreate: (title: string) =>
    request<VolumeMutationPreview>(
      "/api/volumes/preview",
      json("POST", { title }),
    ),
  previewVolumeEdit: (volumeId: string, title: string) =>
    request<VolumeMutationPreview>(
      `/api/volumes/${encodeURIComponent(volumeId)}/preview`,
      json("PUT", { title }),
    ),
  previewVolumeArchive: (volumeId: string, reason: string) =>
    request<VolumeMutationPreview>(
      `/api/volumes/${encodeURIComponent(volumeId)}/archive/preview`,
      json("POST", { reason }),
    ),
  volumeArchives: () => request<VolumeArchiveEntry[]>("/api/archives/volumes"),
  previewVolumeRestore: (archiveId: string) =>
    request<VolumeMutationPreview>(
      `/api/archives/volumes/${encodeURIComponent(archiveId)}/restore/preview`,
      json("POST"),
    ),
  commitVolumeMutation: (token: string, confirmationKeys: string[] = []) =>
    request<VolumeMutationCommitResult>(
      `/api/mutations/${encodeURIComponent(token)}/commit`,
      json("POST", { confirmed: true, confirmationKeys }),
    ),
  chapter: (volumeId: string, chapterId: string) =>
    request<ChapterDetail>(
      `/api/volumes/${encodeURIComponent(volumeId)}/chapters/${encodeURIComponent(chapterId)}`,
    ),
  chapterCreateDefaults: (volumeId: string) =>
    request<ChapterCreateDefaults>(
      `/api/volumes/${encodeURIComponent(volumeId)}/chapters/new`,
    ),
  previewChapterCreate: (volumeId: string, content: string) =>
    request<ChapterMutationPreview>(
      `/api/volumes/${encodeURIComponent(volumeId)}/chapters/preview`,
      json("POST", { content }),
    ),
  previewChapterEdit: (
    volumeId: string,
    chapterId: string,
    content: string,
    expectedHash: string,
  ) =>
    request<ChapterMutationPreview>(
      `/api/volumes/${encodeURIComponent(volumeId)}/chapters/${encodeURIComponent(chapterId)}/preview`,
      json("PUT", { content, expectedHash }),
    ),
  previewChapterArchive: (
    volumeId: string,
    chapterId: string,
    reason: string,
    expectedHash: string,
    confirmFinal: boolean,
  ) =>
    request<ChapterMutationPreview>(
      `/api/volumes/${encodeURIComponent(volumeId)}/chapters/${encodeURIComponent(chapterId)}/archive/preview`,
      json("POST", { reason, expectedHash, confirmFinal }),
    ),
  previewChapterDelete: (volumeId: string, chapterId: string, expectedHash: string) =>
    request<ChapterMutationPreview>(
      `/api/volumes/${encodeURIComponent(volumeId)}/chapters/${encodeURIComponent(chapterId)}/delete/preview`,
      json("POST", { expectedHash }),
    ),
  chapterArchives: () =>
    request<ChapterArchiveEntry[]>("/api/archives/chapters"),
  previewChapterRestore: (archiveId: string) =>
    request<ChapterMutationPreview>(
      `/api/archives/chapters/${encodeURIComponent(archiveId)}/restore/preview`,
      json("POST"),
    ),
  commitChapterMutation: (token: string, confirmationKeys: string[] = []) =>
    request<ChapterMutationCommitResult>(
      `/api/mutations/${encodeURIComponent(token)}/commit`,
      json("POST", { confirmed: true, confirmationKeys }),
    ),
  createTask: (
    volumeId: string,
    chapterId: string,
    allowFinalRevision = false,
  ) =>
    request<TaskDetail>(
      "/api/tasks",
      json("POST", { volumeId, chapterId, allowFinalRevision }),
    ),
  tasks: () => request<ProductionTaskSummary[]>("/api/tasks"),
  task: (id: string) =>
    request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
  rewindTask: (id: string, stage: TaskStage) =>
    request<TaskDetail>(
      `/api/tasks/${encodeURIComponent(id)}/stage`,
      json("PUT", { stage }),
    ),
  context: (id: string) =>
    request<ContextResponse>(`/api/tasks/${encodeURIComponent(id)}/context`),
  buildContext: (id: string, selectedPaths: string[]) =>
    request<ContextResponse>(
      `/api/tasks/${encodeURIComponent(id)}/context/build`,
      json("POST", { selectedPaths }),
    ),
  contextPackageDownloadUrl: (id: string) =>
    `/api/tasks/${encodeURIComponent(id)}/context-package/download`,
  buildRevisionPackage: (id: string) =>
    request<{ zipPath: string }>(
      `/api/tasks/${encodeURIComponent(id)}/revision-package`,
      json("POST"),
    ),
  buildCompactRevisionPackage: (id: string) =>
    request<{ zipPath: string }>(
      `/api/tasks/${encodeURIComponent(id)}/revision-package/compact`,
      json("POST"),
    ),
  buildCompactTextRevisionPackage: (id: string) =>
    request<{ textPath: string }>(
      `/api/tasks/${encodeURIComponent(id)}/revision-package/compact-text`,
      json("POST"),
    ),
  revisionPackageDownloadUrl: (id: string) =>
    `/api/tasks/${encodeURIComponent(id)}/revision-package/download`,
  compactRevisionPackageDownloadUrl: (id: string) =>
    `/api/tasks/${encodeURIComponent(id)}/revision-package/compact/download`,
  compactTextRevisionPackageDownloadUrl: (id: string) =>
    `/api/tasks/${encodeURIComponent(id)}/revision-package/compact-text/download`,
  importReview: (id: string, content: string) =>
    request<TaskDetail>(
      `/api/tasks/${encodeURIComponent(id)}/review`,
      json("POST", { content }),
    ),
  decisions: (
    id: string,
    decisions: Array<{
      id: string;
      decision: DecisionStatus;
      decisionNote?: string;
    }>,
    revisionInstructionAdditions: string[] = [],
  ) =>
    request<TaskDetail>(
      `/api/tasks/${encodeURIComponent(id)}/decisions`,
      json("PUT", { decisions, revisionInstructionAdditions }),
    ),
  importRevision: (id: string, content: string) =>
    request<TaskDetail>(
      `/api/tasks/${encodeURIComponent(id)}/revision`,
      json("POST", { content }),
    ),
  /** 保存人工终审正文并进入独立的五项确认阶段。 */
  saveHumanFinal: (id: string, content: string) =>
    request<TaskDetail>(
      `/api/tasks/${encodeURIComponent(id)}/human-final`,
      json("PUT", { content }),
    ),
  /** 提交五项作者确认并开放正式写入预览。 */
  confirmFinal: (id: string, confirmation: FinalConfirmation) =>
    request<TaskDetail>(
      `/api/tasks/${encodeURIComponent(id)}/final-confirmation`,
      json("POST", confirmation),
    ),
  writePreview: (id: string) =>
    request<WritePreview>(
      `/api/tasks/${encodeURIComponent(id)}/write/preview`,
      json("POST"),
    ),
  commitWrite: (id: string, token: string) =>
    request<TaskDetail>(
      `/api/tasks/${encodeURIComponent(id)}/write/commit`,
      json("POST", { token }),
    ),
  archiveTask: (id: string) =>
    request<TaskDetail>(
      `/api/tasks/${encodeURIComponent(id)}/archive`,
      json("POST"),
    ),
  git: () => request<GitStatusSummary>("/api/git/status"),
  versions: () => request<NovelVersion[]>("/api/git/versions"),
  createVersion: (message: string) => request<NovelVersion>("/api/git/versions", json("POST", { message })),
  documents: (query: string) =>
    request<DocumentSearchResult[]>(
      `/api/documents?query=${encodeURIComponent(query)}`,
    ),
  document: (path: string) =>
    request<DocumentDetail>(
      `/api/documents/content?path=${encodeURIComponent(path)}`,
    ),
  documentTree: () => request<DocumentTreeNode[]>("/api/documents/tree"),
  previewDocumentCreate: (path: string, content: string) =>
    request<DocumentMutationPreview>(
      "/api/documents/preview",
      json("POST", { path, content }),
    ),
  previewDocumentEdit: (path: string, content: string, expectedHash: string) =>
    request<DocumentMutationPreview>(
      "/api/documents/preview",
      json("PUT", { path, content, expectedHash }),
    ),
  previewDocumentArchive: (
    path: string,
    reason: string,
    expectedHash: string,
  ) =>
    request<DocumentMutationPreview>(
      "/api/documents/archive/preview",
      json("POST", { path, reason, expectedHash }),
    ),
  documentArchives: () =>
    request<DocumentArchiveEntry[]>("/api/archives/documents"),
  previewDocumentRestore: (archiveId: string) =>
    request<DocumentMutationPreview>(
      `/api/archives/documents/${encodeURIComponent(archiveId)}/restore/preview`,
      json("POST"),
    ),
  commitDocumentMutation: (token: string, confirmationKeys: string[] = []) =>
    request<DocumentMutationCommitResult>(
      `/api/mutations/${encodeURIComponent(token)}/commit`,
      json("POST", { confirmed: true, confirmationKeys }),
    ),
  novelMetadata: () => request<NovelMetadataDetail>("/api/novel"),
  previewNovelMetadata: (
    metadata: NovelMetadataValues,
    expectedHash?: string,
    coverFile?: File,
  ) =>
    Promise.resolve(coverFile ? fileToBase64(coverFile) : undefined).then(
      (contentBase64) =>
        request<NovelMetadataPreview>(
          "/api/novel/preview",
          json("PUT", {
            title: metadata.title,
            author: metadata.author,
            description: metadata.description,
            ...(metadata.currentVolume
              ? { currentVolume: metadata.currentVolume }
              : undefined),
            ...(metadata.currentChapter
              ? { currentChapter: metadata.currentChapter }
              : undefined),
            ...(coverFile && contentBase64
              ? {
                  coverUpload: {
                    name: coverFile.name,
                    mimeType: coverFile.type,
                    contentBase64,
                  },
                }
              : undefined),
            ...(expectedHash ? { expectedHash } : undefined),
          }),
        ),
    ),
  commitNovelMetadata: (token: string, confirmationKeys: string[] = []) =>
    request<NovelMetadataCommitResult>(
      `/api/mutations/${encodeURIComponent(token)}/commit`,
      json("POST", { confirmed: true, confirmationKeys }),
    ),
  open: (path: string, target: "default" | "folder" = "default") =>
    request<{ opened: boolean }>(
      "/api/system/open",
      json("POST", { path, target }),
    ),
  automation: () =>
    request<AutomationCapabilities>("/api/automation/capabilities"),
};
