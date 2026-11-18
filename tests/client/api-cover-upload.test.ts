/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../client/src/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("小说封面客户端请求", () => {
  it("把文件原始字节编码为 Base64 后随元数据预览发送", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: { ready: true, sessionToken: "cover-session" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            token: "cover-preview",
            kind: "edit",
            expiresAt: "2026-07-19T03:00:00.000Z",
            targetPath: "00_项目/小说.yaml",
            diff: [],
            plannedChanges: ["创建 70_素材/封面.png"],
            referenceImpacts: [],
            confirmationRequirements: ["confirm-novel-metadata-update"],
            destinationHref: "/novel",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([bytes], "作者选择.png", { type: "image/png" });

    await api.previewNovelMetadata(
      {
        title: "示例小说",
        author: "澜蔷薇",
        description: "",
      },
      "a".repeat(64),
      file,
    );

    const [, request] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(request.body as string)).toMatchObject({
      coverUpload: {
        name: "作者选择.png",
        mimeType: "image/png",
        contentBase64: "iVBORw0KGgo=",
      },
    });
  });
});
