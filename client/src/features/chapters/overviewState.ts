import type { VolumeSummary } from "../../../../shared/contracts";

const STORAGE_PREFIX = "evp-ai-novel:chapter-volumes:v1:";

/** 为单活动仓库生成独立的章节折叠偏好键。 */
export function overviewStorageKey(repositoryRoot: string): string {
  return `${STORAGE_PREFIX}${repositoryRoot}`;
}

/** 当前任务优先，其次活动卷，最后第一卷。 */
export function defaultExpandedVolumeIds(
  volumes: VolumeSummary[],
  currentVolumeId?: string,
): string[] {
  if (
    currentVolumeId &&
    volumes.some((volume) => volume.id === currentVolumeId)
  )
    return [currentVolumeId];
  const active = volumes.find((volume) => volume.lifecycleStatus === "active");
  return active ? [active.id] : volumes[0] ? [volumes[0].id] : [];
}

/** 读取并清理仓库折叠偏好；null 表示没有可用偏好，应采用默认值。 */
export function readExpandedVolumeIds(
  storage: Pick<Storage, "getItem">,
  repositoryRoot: string,
  volumes: VolumeSummary[],
): string[] | null {
  try {
    const serialized = storage.getItem(overviewStorageKey(repositoryRoot));
    if (serialized === null) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string"))
      return null;
    if (parsed.length === 0) return [];
    const validIds = new Set(volumes.map((volume) => volume.id));
    const valid = [...new Set(parsed)].filter((id) => validIds.has(id));
    return valid.length ? valid : null;
  } catch {
    return null;
  }
}

/** 保存仓库折叠偏好；浏览器禁用存储时静默退化为当前会话状态。 */
export function writeExpandedVolumeIds(
  storage: Pick<Storage, "setItem">,
  repositoryRoot: string,
  volumeIds: string[],
): void {
  try {
    storage.setItem(
      overviewStorageKey(repositoryRoot),
      JSON.stringify([...new Set(volumeIds)]),
    );
  } catch {
    // localStorage 属于可选界面偏好，失败不能阻断仓库浏览。
  }
}

/** 将组件库单值或多值 activeKey 统一为字符串数组。 */
export function normalizeExpandedKeys(
  activeKey: string | number | Array<string | number> | null,
): string[] {
  if (activeKey === null) return [];
  return (Array.isArray(activeKey) ? activeKey : [activeKey]).map(String);
}
