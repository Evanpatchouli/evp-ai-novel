import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { Button, Dialog } from "@ldkj/web-ui";
import { useBlocker } from "react-router";

export interface UnsavedChangesContextValue {
  hasUnsavedChanges: boolean;
  /** 在执行仓库切换等非路由操作前，请求作者放弃草稿。 */
  requestDiscard(): Promise<boolean>;
}

interface InternalUnsavedChangesContextValue extends UnsavedChangesContextValue {
  setSourceDirty(source: symbol, dirty: boolean): void;
}

const UnsavedChangesContext =
  createContext<InternalUnsavedChangesContextValue | null>(null);

/**
 * 集中管理未保存草稿的确认对话框，供路由和仓库切换共用。
 */
export function UnsavedChangesProvider({ children }: PropsWithChildren) {
  const [dirtySources, setDirtySources] = useState<Set<symbol>>(
    () => new Set(),
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const pendingResolvers = useRef<Array<(allowed: boolean) => void>>([]);
  const hasUnsavedChanges = dirtySources.size > 0;
  const dirtyRef = useRef(hasUnsavedChanges);
  dirtyRef.current = hasUnsavedChanges;

  const setSourceDirty = useCallback((source: symbol, dirty: boolean) => {
    setDirtySources((current) => {
      const contains = current.has(source);
      if (contains === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(source);
      else next.delete(source);
      return next;
    });
  }, []);

  const requestDiscard = useCallback(() => {
    if (!dirtyRef.current) return Promise.resolve(true);
    setDialogOpen(true);
    return new Promise<boolean>((resolve) => {
      pendingResolvers.current.push(resolve);
    });
  }, []);

  const settleRequest = useCallback((allowed: boolean) => {
    setDialogOpen(false);
    const resolvers = pendingResolvers.current.splice(0);
    resolvers.forEach((resolve) => resolve(allowed));
  }, []);

  useEffect(
    () => () => {
      pendingResolvers.current.splice(0).forEach((resolve) => resolve(false));
    },
    [],
  );

  const value = useMemo<InternalUnsavedChangesContextValue>(
    () => ({
      hasUnsavedChanges,
      requestDiscard,
      setSourceDirty,
    }),
    [hasUnsavedChanges, requestDiscard, setSourceDirty],
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) settleRequest(false);
        }}
        closeOnMaskClick
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>放弃未保存的修改？</Dialog.Title>
            <Dialog.Description>
              当前修改尚未写入文件。离开后这些修改将丢失。
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Footer>
            <Button
              type="button"
              variant="ghost"
              onClick={() => settleRequest(false)}
            >
              继续编辑
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => settleRequest(true)}
            >
              放弃并离开
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </UnsavedChangesContext.Provider>
  );
}

/** 读取全局草稿保护状态，可用于仓库切换等外部操作。 */
export function useUnsavedChanges(): UnsavedChangesContextValue {
  const value = useContext(UnsavedChangesContext);
  if (!value) {
    throw new Error("useUnsavedChanges 必须在 UnsavedChangesProvider 内使用");
  }
  return value;
}

/**
 * 为一个编辑器注册 dirty 状态，并阻止路由导航与浏览器刷新。
 */
export function useUnsavedChangesGuard(dirty: boolean): void {
  const context = useContext(UnsavedChangesContext);
  if (!context) {
    throw new Error(
      "useUnsavedChangesGuard 必须在 UnsavedChangesProvider 内使用",
    );
  }
  const { requestDiscard, setSourceDirty } = context;
  const source = useRef(Symbol("unsaved-editor"));

  useEffect(() => {
    setSourceDirty(source.current, dirty);
  }, [dirty, setSourceDirty]);
  useEffect(
    () => () => setSourceDirty(source.current, false),
    [setSourceDirty],
  );

  useEffect(() => {
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !==
        `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let active = true;
    void requestDiscard().then((allowed) => {
      if (!active || blocker.state !== "blocked") return;
      if (allowed) blocker.proceed();
      else blocker.reset();
    });
    return () => {
      active = false;
    };
  }, [blocker, requestDiscard]);
}
