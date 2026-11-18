/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceToRoot,
  AppearanceProvider,
  readStoredAppearance,
  writeStoredAppearance,
} from "../../client/src/app/appearance";
import { AppearanceSelect } from "../../client/src/app/AppearanceSelect";

const values = new Map<string, string>();
const testStorage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, value),
};

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
});

beforeEach(() => {
  vi.stubGlobal("localStorage", testStorage);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: testStorage,
  });
});

afterEach(() => {
  testStorage.clear();
  document.documentElement.removeAttribute("data-appearance");
  document.documentElement.style.colorScheme = "";
  vi.unstubAllGlobals();
});

describe("工作台外观模式", () => {
  it("仅接受已知的本地外观值，其余情况回退到宣纸白", () => {
    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
    };

    localStorage.setItem(APPEARANCE_STORAGE_KEY, "sky");
    expect(readStoredAppearance(localStorage)).toBe("sky");

    localStorage.setItem(APPEARANCE_STORAGE_KEY, "unknown");
    expect(readStoredAppearance(localStorage)).toBe("plain");
    expect(readStoredAppearance(unavailableStorage)).toBe("plain");
  });

  it("本地存储写入失败不阻断界面切换", () => {
    expect(() =>
      writeStoredAppearance("sky", {
        setItem: () => {
          throw new Error("quota exceeded");
        },
      }),
    ).not.toThrow();
  });

  it("同步根节点标记与浏览器原生配色提示", () => {
    applyAppearanceToRoot(document.documentElement, "modern");

    expect(document.documentElement.dataset.appearance).toBe("modern");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyAppearanceToRoot(document.documentElement, "sky");
    expect(document.documentElement.dataset.appearance).toBe("sky");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("通过顶部栏 Select 切换并持久化晴空蓝", async () => {
    const user = userEvent.setup();
    render(
      <AppearanceProvider initialAppearance="plain">
        <AppearanceSelect />
      </AppearanceProvider>,
    );

    const control = screen.getByRole("combobox", {
      name: "界面风格",
    });
    await user.click(control);
    await user.click(screen.getByRole("option", { name: "晴空蓝" }));

    expect(document.documentElement.dataset.appearance).toBe("sky");
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("sky");
    expect(screen.getByText("晴空蓝")).toBeTruthy();
  });
});
