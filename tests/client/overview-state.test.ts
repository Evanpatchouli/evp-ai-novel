import { describe, expect, it } from "vitest";
import type { VolumeSummary } from "../../shared/contracts.js";
import {
  defaultExpandedVolumeIds,
  normalizeExpandedKeys,
  overviewStorageKey,
  readExpandedVolumeIds,
  writeExpandedVolumeIds,
} from "../../client/src/features/chapters/overviewState.js";

function volume(
  id: string,
  lifecycleStatus: VolumeSummary["lifecycleStatus"],
): VolumeSummary {
  return {
    id,
    number: Number(id.slice(1)),
    title: id,
    lifecycleStatus,
    chapterCount: 0,
    finalCount: 0,
    aiRevisedCount: 0,
    inProgressCount: 0,
    chapters: [],
  };
}

const volumes = [volume("v01", "planned"), volume("v02", "active")];

describe("章节总览折叠状态", () => {
  it("默认顺序为当前任务卷、活动卷、第一卷", () => {
    expect(defaultExpandedVolumeIds(volumes, "v01")).toEqual(["v01"]);
    expect(defaultExpandedVolumeIds(volumes)).toEqual(["v02"]);
    expect(
      defaultExpandedVolumeIds([
        volume("v01", "planned"),
        volume("v02", "planned"),
      ]),
    ).toEqual(["v01"]);
    expect(defaultExpandedVolumeIds([])).toEqual([]);
  });

  it("按仓库隔离并过滤失效卷 ID", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    writeExpandedVolumeIds(storage, "C:/novel-a", ["v01", "v02", "v02"]);
    writeExpandedVolumeIds(storage, "C:/novel-b", []);

    expect(readExpandedVolumeIds(storage, "C:/novel-a", [volumes[1]!])).toEqual(
      ["v02"],
    );
    expect(readExpandedVolumeIds(storage, "C:/novel-b", volumes)).toEqual([]);
    expect(overviewStorageKey("C:/novel-a")).not.toBe(
      overviewStorageKey("C:/novel-b"),
    );
  });

  it("无效偏好回退默认值并规范组件 activeKey", () => {
    const storage = { getItem: () => "not-json" };
    expect(readExpandedVolumeIds(storage, "C:/novel", volumes)).toBeNull();
    expect(normalizeExpandedKeys(null)).toEqual([]);
    expect(normalizeExpandedKeys("v01")).toEqual(["v01"]);
    expect(normalizeExpandedKeys(["v01", 2])).toEqual(["v01", "2"]);
  });
});
