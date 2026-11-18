import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import type { PropsWithChildren } from "react";
import type { DashboardData } from "../../../shared/contracts";
import { api, type ManagedNovel, type TaskDetail } from "../api";
import type { Notice, ShowNotice } from "./types";

export interface RepositorySessionState {
  dashboard: DashboardData | null;
  task: TaskDetail | null;
  repositoryPath: string;
  loading: boolean;
  repositoryBusy: boolean;
  error: string;
  notice: Notice;
}

export const initialRepositorySession: RepositorySessionState = {
  dashboard: null,
  task: null,
  repositoryPath: "",
  loading: true,
  repositoryBusy: false,
  error: "",
  notice: null,
};

type RepositorySessionAction =
  | { type: "empty" }
  | { type: "loading" }
  | { type: "loaded"; dashboard: DashboardData; task: TaskDetail | null }
  | { type: "dashboard-refreshed"; dashboard: DashboardData }
  | { type: "failed"; message: string }
  | { type: "switching"; repositoryPath: string }
  | { type: "switch-finished" }
  | { type: "set-path"; repositoryPath: string }
  | { type: "set-task"; task: TaskDetail | null }
  | { type: "clear-task"; taskId: string }
  | { type: "notice"; notice: Notice };

export function repositorySessionReducer(
  state: RepositorySessionState,
  action: RepositorySessionAction,
): RepositorySessionState {
  switch (action.type) {
    case "empty":
      return { ...state, dashboard: null, task: null, repositoryPath: "", loading: false, error: "" };
    case "loading":
      return { ...state, loading: true, error: "" };
    case "loaded":
      return {
        ...state,
        dashboard: action.dashboard,
        task: action.task,
        repositoryPath: action.dashboard.repositoryRoot,
        loading: false,
        error: "",
      };
    case "dashboard-refreshed":
      if (
        !state.dashboard ||
        action.dashboard.repositoryRoot !== state.dashboard.repositoryRoot
      )
        return state;
      return { ...state, dashboard: action.dashboard };
    case "failed":
      return { ...state, loading: false, error: action.message };
    case "switching":
      return {
        ...state,
        dashboard: null,
        task: null,
        repositoryPath: action.repositoryPath,
        loading: true,
        repositoryBusy: true,
        error: "",
      };
    case "switch-finished":
      return { ...state, repositoryBusy: false };
    case "set-path":
      return { ...state, repositoryPath: action.repositoryPath };
    case "set-task":
      return { ...state, task: action.task };
    case "clear-task":
      return state.task?.id === action.taskId
        ? { ...state, task: null }
        : state;
    case "notice":
      return { ...state, notice: action.notice };
  }
}

interface RepositorySessionValue extends RepositorySessionState {
  loadDashboard(): Promise<void>;
  refreshDashboard(): Promise<void>;
  selectRepository(root: string): Promise<boolean>;
  novels: ManagedNovel[];
  selectedId: string;
  createNovel(title: string, author: string, description: string): Promise<boolean>;
  deleteNovel(id: string): Promise<string | undefined>;
  setRepositoryPath(path: string): void;
  setTask(task: TaskDetail | null): void;
  clearTask(taskId: string): void;
  showNotice: ShowNotice;
  clearNotice(): void;
}

const RepositorySessionContext = createContext<RepositorySessionValue | null>(
  null,
);

export function RepositorySessionProvider({ children }: PropsWithChildren) {
  const [novels, setNovels] = useState<ManagedNovel[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [state, dispatch] = useReducer(
    repositorySessionReducer,
    initialRepositorySession,
  );

  const loadDashboard = useCallback(async () => {
    dispatch({ type: "loading" });
    try {
      const library = await api.novels();
      setNovels(library.novels);
      setSelectedId(library.selectedId ?? "");
      if (!library.selectedId) { dispatch({ type: "empty" }); return; }
      const dashboard = await api.dashboard();
      const task = dashboard.currentTask
        ? await api.task(dashboard.currentTask.id)
        : null;
      dispatch({ type: "loaded", dashboard, task });
    } catch (cause) {
      dispatch({
        type: "failed",
        message: cause instanceof Error ? cause.message : "无法读取工程数据",
      });
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const refreshDashboard = useCallback(async () => {
    const library = await api.novels();
    setNovels(library.novels);
    const dashboard = await api.dashboard();
    dispatch({ type: "dashboard-refreshed", dashboard });
  }, []);
  useEffect(() => {
    if (!state.notice || state.notice.actions?.length) return;
    const timer = window.setTimeout(
      () => dispatch({ type: "notice", notice: null }),
      4200,
    );
    return () => window.clearTimeout(timer);
  }, [state.notice]);

  const selectRepository = useCallback(async (root: string) => {
    const normalized = root.trim();
    if (!normalized) return false;
    dispatch({ type: "switching", repositoryPath: normalized });
    try {
      await api.selectNovel(normalized);
      setSelectedId(normalized);
      const dashboard = await api.dashboard();
      const task = dashboard.currentTask
        ? await api.task(dashboard.currentTask.id)
        : null;
      dispatch({ type: "loaded", dashboard, task });
      dispatch({
        type: "notice",
        notice: { tone: "success", message: "仓库已切换并重新读取工程。" },
      });
      return true;
    } catch (cause) {
      dispatch({
        type: "failed",
        message: cause instanceof Error ? cause.message : "仓库选择失败",
      });
      dispatch({
        type: "notice",
        notice: {
          tone: "error",
          message: cause instanceof Error ? cause.message : "仓库选择失败",
        },
      });
      return false;
    } finally {
      dispatch({ type: "switch-finished" });
    }
  }, []);

  const createNovel = useCallback(async (title: string, author: string, description: string) => {
    try {
      const novel = await api.createNovel(title, author, description);
      setNovels((items) => [...items, novel]);
      return await selectRepository(novel.id);
    } catch (cause) {
      dispatch({ type: "notice", notice: { tone: "error", message: cause instanceof Error ? cause.message : "创建小说失败" } });
      return false;
    }
  }, [selectRepository]);

  const deleteNovel = useCallback(async (id: string) => {
    const result = await api.deleteNovel(id);
    setNovels(result.novels);
    setSelectedId(result.selectedId ?? "");
    if (id === selectedId) {
      if (result.selectedId) {
        dispatch({ type: "switching", repositoryPath: "" });
        try {
          await loadDashboard();
        } finally {
          dispatch({ type: "switch-finished" });
        }
      } else {
        dispatch({ type: "empty" });
      }
    }
    return result.remainingPath;
  }, [loadDashboard, selectedId]);

  const value = useMemo<RepositorySessionValue>(
    () => ({
      ...state,
      novels, selectedId, createNovel, deleteNovel,
      loadDashboard,
      refreshDashboard,
      selectRepository,
      setRepositoryPath: (repositoryPath) =>
        dispatch({ type: "set-path", repositoryPath }),
      setTask: (task) => dispatch({ type: "set-task", task }),
      clearTask: (taskId) => dispatch({ type: "clear-task", taskId }),
      showNotice: (notice) => dispatch({ type: "notice", notice }),
      clearNotice: () => dispatch({ type: "notice", notice: null }),
    }),
    [loadDashboard, refreshDashboard, selectRepository, createNovel, deleteNovel, novels, selectedId, state],
  );

  return (
    <RepositorySessionContext.Provider value={value}>
      {children}
    </RepositorySessionContext.Provider>
  );
}

export function useRepositorySession(): RepositorySessionValue {
  const value = useContext(RepositorySessionContext);
  if (!value)
    throw new Error(
      "useRepositorySession 必须在 RepositorySessionProvider 内使用",
    );
  return value;
}
