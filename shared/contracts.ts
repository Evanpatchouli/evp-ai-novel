export type ChapterStatus =
  "draft" | "ai-revised" | "human-revising" | "final" | string;

export interface ChapterSummary {
  id: string;
  number: number;
  title: string;
  path: string;
  status: ChapterStatus;
  humanApproved: boolean;
  reviewGate?: string;
  wordCount: number;
  lengthFlag: "short" | "normal" | "long";
  modifiedAt: string;
}

export interface VolumeSummary {
  id: string;
  number: number;
  title: string;
  lifecycleStatus: "planned" | "active" | "archived";
  chapterCount: number;
  finalCount: number;
  aiRevisedCount: number;
  inProgressCount: number;
  chapters: ChapterSummary[];
}

export type RepositoryHealthSeverity = "blocking" | "warning";

export interface RepositoryHealthIssue {
  code: string;
  severity: RepositoryHealthSeverity;
  message: string;
  path?: string;
  volumeId?: string;
  chapterId?: string;
  rangeIndex?: number;
  details?: unknown;
}

export interface RepositoryHealth {
  healthy: boolean;
  issues: RepositoryHealthIssue[];
}

export interface ChapterLink {
  volumeId: string;
  volumeNumber: number;
  chapterId: string;
  chapterNumber: number;
  title: string;
}

export interface VolumeRelatedRecord {
  kind: "review" | "production" | "publication";
  path: string;
  title: string;
}

export interface VolumeDetail extends VolumeSummary {
  totalWordCount: number;
  statusCounts: Record<string, number>;
  firstChapter?: ChapterLink;
  lastChapter?: ChapterLink;
  currentChapterId?: string;
  outline?: {
    path: string;
    title: string;
  };
  relatedRecords: VolumeRelatedRecord[];
  healthIssues: RepositoryHealthIssue[];
}

export interface VolumeIndexData {
  volumes: VolumeSummary[];
  health: RepositoryHealth;
  currentVolumeId?: string;
  currentChapterId?: string;
}

export interface ChapterDetail extends ChapterSummary {
  volumeId: string;
  chapterId: string;
  volume: {
    id: string;
    number: number;
    title: string;
  };
  content: string;
  sourceHash: string;
  previous?: ChapterLink;
  next?: ChapterLink;
  healthIssues: RepositoryHealthIssue[];
}

export type ChapterMutationKind = "edit" | "create" | "archive" | "restore" | "delete";

export interface ChapterReferenceImpact {
  path: string;
  kind: "production" | "review" | "publication" | "planning";
  severity: "blocking" | "warning";
  evidence: string;
}

export interface ChapterMutationPreview {
  token: string;
  kind: ChapterMutationKind;
  expiresAt: string;
  volumeId: string;
  chapterId: string;
  targetPath: string;
  beforeHash?: string;
  afterHash?: string;
  beforeWordCount: number;
  afterWordCount: number;
  diff: TextChange[];
  plannedChanges: string[];
  referenceImpacts: ChapterReferenceImpact[];
  confirmationRequirements: string[];
  destinationHref: string;
  archiveId?: string;
}

export interface ChapterCreateDefaults {
  volumeId: string;
  chapterId: string;
  number: number;
  targetPath: string;
  initialContent: string;
}

export interface ChapterArchiveEntry {
  id: string;
  archivedAt: string;
  volumeId: string;
  chapterId: string;
  title: string;
  originalPath: string;
  archivePath: string;
  reason: string;
  status: ChapterStatus;
  restorable: boolean;
  restoredAt?: string;
  restoreIssue?: string;
}

export interface ChapterMutationCommitResult {
  kind: ChapterMutationKind;
  volumeId: string;
  chapterId: string;
  destinationHref: string;
  chapter?: ChapterDetail;
  archiveId?: string;
}

export type VolumeMutationKind = "create" | "rename" | "archive" | "restore" | "delete";

export interface VolumeReferenceImpact {
  path: string;
  kind: "production" | "review" | "publication" | "planning";
  severity: "blocking" | "warning";
  evidence: string;
}

export interface VolumeMutationPreview {
  token: string;
  kind: VolumeMutationKind;
  expiresAt: string;
  volumeId: string;
  volumeNumber: number;
  targetPath: string;
  diff: TextChange[];
  plannedChanges: string[];
  referenceImpacts: VolumeReferenceImpact[];
  confirmationRequirements: string[];
  destinationHref: string;
  archiveId?: string;
}

export interface VolumeCreateDefaults {
  volumeId: string;
  volumeNumber: number;
  targetPath: string;
}

export interface VolumeArchiveEntry {
  id: string;
  archivedAt: string;
  volumeId: string;
  volumeNumber: number;
  title: string;
  originalPath: string;
  reason: string;
  restorable: boolean;
  restoredAt?: string;
  restoreIssue?: string;
}

export interface VolumeMutationCommitResult {
  kind: VolumeMutationKind;
  volumeId: string;
  destinationHref: string;
  archiveId?: string;
  volume?: VolumeDetail;
}

export type DocumentAuthority = ContextCandidate["authority"];

export interface DocumentCapabilities {
  readable: boolean;
  creatable: boolean;
  editable: boolean;
  archivable: boolean;
}

export interface DocumentTreeNode {
  kind: "directory" | "file";
  name: string;
  path: string;
  authority: DocumentAuthority;
  capabilities: DocumentCapabilities;
  warning?: string;
  modifiedAt?: string;
  size?: number;
  children?: DocumentTreeNode[];
}

export interface DocumentDetail {
  path: string;
  content: string;
  sourceHash: string;
  authority: DocumentAuthority;
  capabilities: DocumentCapabilities;
  modifiedAt: string;
  size: number;
  warning?: string;
}

export type DocumentMutationKind = "create" | "edit" | "archive" | "restore";

export interface DocumentReferenceImpact {
  path: string;
  kind: "task" | "markdown-link" | "suspected-text";
  severity: "blocking" | "warning";
  evidence: string;
}

export interface DocumentMutationPreview {
  token: string;
  kind: DocumentMutationKind;
  expiresAt: string;
  targetPath: string;
  diff: TextChange[];
  plannedChanges: string[];
  referenceImpacts: DocumentReferenceImpact[];
  confirmationRequirements: string[];
  destinationHref: string;
  archiveId?: string;
}

export interface DocumentArchiveEntry {
  id: string;
  archivedAt: string;
  title: string;
  originalPath: string;
  archivePath: string;
  authority: DocumentAuthority;
  reason: string;
  restorable: boolean;
  restoredAt?: string;
  restoreIssue?: string;
}

export interface DocumentMutationCommitResult {
  kind: DocumentMutationKind;
  destinationHref: string;
  archiveId?: string;
  document?: DocumentDetail;
}

export interface NovelMetadata {
  schema_version: 1;
  novel: {
    id: string;
    title: string;
    author: string;
    description: string;
    cover?: "70_素材/封面.png";
    current_volume?: string;
    current_chapter?: string;
  };
}

export interface NovelMetadataDetail {
  exists: boolean;
  path: "00_项目/小说.yaml";
  sourceHash?: string;
  metadata: NovelMetadata;
}

export interface NovelMetadataPreview {
  token: string;
  kind: "create" | "edit";
  expiresAt: string;
  targetPath: "00_项目/小说.yaml";
  diff: TextChange[];
  plannedChanges: string[];
  referenceImpacts: [];
  confirmationRequirements: string[];
  destinationHref: "/novel";
}

export interface NovelMetadataCommitResult {
  kind: "create" | "edit";
  destinationHref: "/novel";
  novel: NovelMetadataDetail;
}

export interface GitFileChange {
  code: string;
  path: string;
  generatedRisk: boolean;
}

export interface GitStatusSummary {
  branch: string;
  clean: boolean;
  ahead: number;
  behind: number;
  lastCommitAt?: string;
  lastCommitSubject?: string;
  changes: GitFileChange[];
  plainLanguage: string[];
  suggestedCommitMessage: string;
  suggestedCommands: string[];
}

export interface DashboardData {
  repositoryRoot: string;
  projectName: string;
  volumes: VolumeSummary[];
  currentTask?: ProductionTaskSummary;
  health: RepositoryHealth;
  git: GitStatusSummary;
  continuity: {
    characterFiles: number;
    activeForeshadowFiles: number;
    timelineFiles: number;
    unresolvedReviewItems: number;
  };
}

export type ReviewSeverity = "blocker" | "important" | "minor" | "optional";
export type DecisionStatus =
  "approved" | "partially-approved" | "rejected" | "later";

export interface ReviewIssue {
  id: string;
  severity: ReviewSeverity;
  title: string;
  evidence?: string[];
  impact?: string;
  suggestion?: string;
  /** 旧版自由列表报告的正文，仅用于读取已有任务。 */
  detail?: string;
  rawExcerpt?: string;
  decision?: DecisionStatus;
  decisionNote?: string;
}

export type TaskStage =
  | "created"
  | "context-ready"
  | "review-imported"
  | "decisions-recorded"
  | "revision-imported"
  | "human-final-review"
  | "ready-to-write"
  | "written"
  | "archived";

export interface ProductionTaskSummary {
  id: string;
  volumeId: string;
  chapterId: string;
  stage: TaskStage;
  createdAt: string;
  updatedAt: string;
  directory: string;
  nextAction: string;
  pendingDecisionCount: number;
}

export interface ContextCandidate {
  path: string;
  label: string;
  authority:
    | "canonical"
    | "bible"
    | "approved-plan"
    | "plan"
    | "production"
    | "review"
    | "material"
    | "archive";
  selected: boolean;
  reason: string;
  warning?: string;
}

export interface TextChange {
  type: "added" | "removed" | "unchanged";
  value: string;
  count?: number;
}

export interface RevisionAnalysis {
  changes: TextChange[];
  addedRatio: number;
  removedRatio: number;
  titleChanged: boolean;
  possibleNewCanon: string[];
  continuityWarnings: string[];
  largeUnapprovedRewrite: boolean;
}

export interface FinalConfirmation {
  fullyRead: boolean;
  plotAndCharacterApproved: boolean;
  noUnauthorizedCanon: boolean;
  continuityApproved: boolean;
  willingToFinalize: boolean;
}

export interface WritePreview {
  token: string;
  taskId: string;
  targetPath: string;
  statusPath: string;
  beforeHash: string;
  afterHash: string;
  diff: TextChange[];
  expiresAt: string;
}

export interface AutomationCapabilities {
  provider: "disabled" | "playwright";
  enabled: boolean;
  canOpenBrowser: boolean;
  canUploadFiles: boolean;
  canReadOutput: boolean;
  reason: string;
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}
