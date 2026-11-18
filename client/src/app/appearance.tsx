import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const APPEARANCE_MODES = ["plain", "modern", "sky"] as const;

export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

export const APPEARANCE_STORAGE_KEY = "evp-ai-novel:appearance";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

type AppearanceContextValue = {
  appearance: AppearanceMode;
  setAppearance: (appearance: AppearanceMode) => void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

/** 判断存储或控件返回值是否为支持的工作台外观。 */
export function isAppearanceMode(
  value: string | null,
): value is AppearanceMode {
  return APPEARANCE_MODES.some((appearance) => appearance === value);
}

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** 从可选本地存储读取外观偏好，损坏或不可用时安全回退。 */
export function readStoredAppearance(
  storage: ReadableStorage | undefined = browserStorage(),
): AppearanceMode {
  try {
    const storedAppearance = storage?.getItem(APPEARANCE_STORAGE_KEY) ?? null;
    return isAppearanceMode(storedAppearance) ? storedAppearance : "plain";
  } catch {
    return "plain";
  }
}

/** 将外观偏好写入可选存储；界面偏好失败不得阻断工作台。 */
export function writeStoredAppearance(
  appearance: AppearanceMode,
  storage: WritableStorage | undefined = browserStorage(),
) {
  try {
    storage?.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch {
    // 隐私模式或存储配额异常时仍允许本次会话继续切换。
  }
}

/** 同步 CSS 外观入口和浏览器原生控件配色。 */
export function applyAppearanceToRoot(
  root: HTMLElement,
  appearance: AppearanceMode,
) {
  root.dataset.appearance = appearance;
  root.style.colorScheme = appearance === "modern" ? "dark" : "light";
}

export function AppearanceProvider({
  children,
  initialAppearance,
}: {
  children: ReactNode;
  initialAppearance?: AppearanceMode;
}) {
  const [appearance, setAppearance] = useState<AppearanceMode>(
    () => initialAppearance ?? readStoredAppearance(),
  );

  useEffect(() => {
    applyAppearanceToRoot(document.documentElement, appearance);
    writeStoredAppearance(appearance);
  }, [appearance]);

  const value = useMemo(() => ({ appearance, setAppearance }), [appearance]);

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}

/** 读取全局外观状态；仅允许在 AppearanceProvider 内使用。 */
export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context)
    throw new Error("useAppearance 必须在 AppearanceProvider 内使用");
  return context;
}
