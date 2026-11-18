/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, matchRoutes, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../client/src/api";
import { AppearanceProvider } from "../../client/src/app/appearance";
import { appRoutes } from "../../client/src/app/router";

afterEach(cleanup);

describe("阶段 2 阅读深链接", () => {
  it.each([
    ["/chapters/volumes/new", "volumes/new"],
    ["/chapters/volumes/v01", "volumes/:volumeId"],
    ["/chapters/volumes/v01/edit", "volumes/:volumeId/edit"],
    ["/chapters/volumes/v01/chapters/new", "volumes/:volumeId/chapters/new"],
    [
      "/chapters/volumes/v01/chapters/ch002",
      "volumes/:volumeId/chapters/:chapterId",
    ],
  ])("%s 匹配章节子路由", (url, pagePath) => {
    expect(matchRoutes(appRoutes, url)?.map(({ route }) => route.path)).toEqual(
      ["/", "chapters", pagePath],
    );
  });

  it.each(["documents/view", "documents/new", "novel"])(
    "继续匹配 /%s",
    (path) => {
      expect(matchRoutes(appRoutes, `/${path}`)?.at(-1)?.route.path).toBe(path);
    },
  );

  it("旧链接保留查询和锚点，跳转后激活章节且返回时跳过旧地址", async () => {
    vi.spyOn(api, "novels").mockResolvedValue({ novels: [], selectedId: null });
    const router = createMemoryRouter(appRoutes, {
      initialEntries: [
        "/documents",
        "/volumes/v01/chapters/ch002?from=bookmark#content",
      ],
    });
    render(
      <AppearanceProvider initialAppearance="plain">
        <RouterProvider router={router} />
      </AppearanceProvider>,
    );

    const chapters = await screen.findByRole("link", { name: /^章节/ });
    expect(chapters.getAttribute("aria-current")).toBe("page");
    expect(router.state.location).toMatchObject({
      pathname: "/chapters/volumes/v01/chapters/ch002",
      search: "?from=bookmark",
      hash: "#content",
    });
    await act(() => router.navigate(-1));
    await waitFor(() =>
      expect(
        screen
          .getByRole("link", { name: /^文档/ })
          .getAttribute("aria-current"),
      ).toBe("page"),
    );
  });
});
