import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";
/** 页面注册到全局 GhostButtonGroup 的单个快捷操作。 */
export interface PageQuickAction {
  itemKey: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick(): void;
}

interface PageQuickActionsContextValue {
  actions: PageQuickAction[];
  register(source: symbol, actions: readonly PageQuickAction[]): void;
  unregister(source: symbol): void;
}

const PageQuickActionsContext =
  createContext<PageQuickActionsContextValue | null>(null);

/** 汇总当前页面注册的快捷操作，并在页面卸载后清除。 */
export function PageQuickActionsProvider({ children }: PropsWithChildren) {
  const [registrations, setRegistrations] = useState<
    Map<symbol, readonly PageQuickAction[]>
  >(() => new Map());

  const register = useCallback(
    (source: symbol, actions: readonly PageQuickAction[]) => {
      setRegistrations((current) => {
        if (current.get(source) === actions) return current;
        const next = new Map(current);
        next.set(source, actions);
        return next;
      });
    },
    [],
  );
  const unregister = useCallback((source: symbol) => {
    setRegistrations((current) => {
      if (!current.has(source)) return current;
      const next = new Map(current);
      next.delete(source);
      return next;
    });
  }, []);
  const actions = useMemo(
    () => [...registrations.values()].flatMap((registered) => [...registered]),
    [registrations],
  );
  const value = useMemo<PageQuickActionsContextValue>(
    () => ({ actions, register, unregister }),
    [actions, register, unregister],
  );

  return (
    <PageQuickActionsContext.Provider value={value}>
      {children}
    </PageQuickActionsContext.Provider>
  );
}

/**
 * 在当前页面存活期间注册快捷操作。
 *
 * `actions` 应通过 `useMemo` 保持稳定，并在页面状态变化时返回新数组。
 */
export function usePageQuickActions(actions: readonly PageQuickAction[]): void {
  const context = useContext(PageQuickActionsContext);
  if (!context) {
    throw new Error(
      "usePageQuickActions 必须在 PageQuickActionsProvider 内使用",
    );
  }
  const source = useRef(Symbol("page-quick-actions"));
  const { register, unregister } = context;

  useEffect(() => {
    register(source.current, actions);
  }, [actions, register]);
  useEffect(() => () => unregister(source.current), [unregister]);
}

/** 供全局按钮组读取已注册的页面动作。 */
export function useRegisteredPageQuickActions(): readonly PageQuickAction[] {
  return useContext(PageQuickActionsContext)?.actions ?? [];
}
