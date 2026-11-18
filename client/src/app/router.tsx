import {
  Navigate,
  createBrowserRouter,
  useLocation,
  type RouteObject,
} from "react-router";
import { WorkbenchShell } from "./WorkbenchShell";
import { AutomationPage } from "../features/automation/AutomationPage";
import { ArchivePage } from "../features/chapters/ArchivePage";
import { ChapterCreatePage } from "../features/chapters/ChapterCreatePage";
import { ChapterDetailPage } from "../features/chapters/ChapterDetailPage";
import { ChaptersPage } from "../features/chapters/ChaptersPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { DocumentDetailPage } from "../features/documents/DocumentDetailPage";
import { DocumentCreatePage } from "../features/documents/DocumentCreatePage";
import { DocumentsPage } from "../features/documents/DocumentsPage";
import { NovelMetadataPage } from "../features/documents/NovelMetadataPage";
import { GitPage } from "../features/git/GitPage";
import { VolumeDetailPage } from "../features/volumes/VolumeDetailPage";
import { VolumeCreatePage } from "../features/volumes/VolumeCreatePage";
import { VolumeEditPage } from "../features/volumes/VolumeEditPage";
import { WorkflowPage } from "../features/workflow/WorkflowPage";

export const ROUTE_PATHS = [
  "/",
  "/chapters",
  "/chapters/volumes/new",
  "/chapters/volumes/:volumeId",
  "/chapters/volumes/:volumeId/edit",
  "/chapters/volumes/:volumeId/chapters/new",
  "/chapters/volumes/:volumeId/chapters/:chapterId",
  "/archive",
  "/workflow",
  "/workflow/:taskId",
  "/documents",
  "/documents/new",
  "/documents/view",
  "/novel",
  "/git",
  "/automation",
] as const;

function LegacyVolumeRedirect() {
  const { pathname, search, hash } = useLocation();
  return (
    <Navigate to={{ pathname: `/chapters${pathname}`, search, hash }} replace />
  );
}

export const appRoutes: RouteObject[] = [
  { path: "/volumes/*", Component: LegacyVolumeRedirect },
  {
    path: "/",
    Component: WorkbenchShell,
    children: [
      { index: true, Component: DashboardPage },
      {
        path: "chapters",
        children: [
          { index: true, Component: ChaptersPage },
          { path: "volumes/new", Component: VolumeCreatePage },
          { path: "volumes/:volumeId", Component: VolumeDetailPage },
          { path: "volumes/:volumeId/edit", Component: VolumeEditPage },
          {
            path: "volumes/:volumeId/chapters/new",
            Component: ChapterCreatePage,
          },
          {
            path: "volumes/:volumeId/chapters/:chapterId",
            Component: ChapterDetailPage,
          },
        ],
      },
      { path: "workflow", Component: WorkflowPage },
      { path: "workflow/:taskId", Component: WorkflowPage },
      { path: "documents", Component: DocumentsPage },
      { path: "documents/new", Component: DocumentCreatePage },
      { path: "documents/view", Component: DocumentDetailPage },
      { path: "novel", Component: NovelMetadataPage },
      { path: "git", Component: GitPage },
      { path: "automation", Component: AutomationPage },
      { path: "archive", Component: ArchivePage },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
];

export const router = createBrowserRouter(appRoutes);
