import { useEffect, useMemo, useState } from "react";
import { Button, Collapse, Input } from "@ldkj/web-ui";
import { Link } from "react-router";
import { newVolumeHref } from "../../../../shared/reader-paths";
import { useRepositorySession } from "../../app/RepositorySession";
import { PageHeader, Panel } from "../../components/layout";
import { SelectField } from "../../components/SelectField";
import { EmptyState } from "../../components/states";
import { chapterMatchesFilters, chapterStatusLabel } from "./chapterFilter";
import { CollapsibleVolumeSection } from "./CollapsibleVolumeSection";
import {
  defaultExpandedVolumeIds,
  normalizeExpandedKeys,
  readExpandedVolumeIds,
  writeExpandedVolumeIds,
} from "./overviewState";

export function ChaptersPage() {
  const { dashboard } = useRepositorySession();
  const volumes = dashboard?.volumes ?? [];
  const repositoryRoot = dashboard?.repositoryRoot ?? "";
  const currentVolumeId = dashboard?.currentTask?.volumeId;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [expandedVolumeIds, setExpandedVolumeIds] = useState<string[]>(() => {
    if (!dashboard) return [];
    return (
      readExpandedVolumeIds(localStorage, repositoryRoot, volumes) ?? defaultExpandedVolumeIds(volumes, currentVolumeId)
    );
  });

  const volumeSignature = volumes.map((volume) => volume.id).join("\u0000");
  useEffect(() => {
    if (!dashboard) return;
    setExpandedVolumeIds(
      readExpandedVolumeIds(localStorage, repositoryRoot, volumes) ??
        defaultExpandedVolumeIds(volumes, currentVolumeId),
    );
    // 卷集合改变时也要剔除已经不存在的本地偏好。
  }, [currentVolumeId, dashboard, repositoryRoot, volumeSignature]);

  const filtered = Boolean(query.trim()) || status !== "all";
  const volumeResults = useMemo(
    () =>
      volumes.map((volume) => ({
        volume,
        chapters: filtered
          ? volume.chapters.filter((chapter) => chapterMatchesFilters(chapter, query, status))
          : volume.chapters,
      })),
    [filtered, query, status, volumes],
  );
  const visibleResults = filtered ? volumeResults.filter(({ chapters }) => chapters.length > 0) : volumeResults;
  const filteredExpandedIds = filtered ? visibleResults.map(({ volume }) => volume.id) : expandedVolumeIds;

  const statuses = useMemo(
    () =>
      [...new Set(volumes.flatMap((volume) => volume.chapters.map((chapter) => chapter.status)))]
        .sort((left, right) => chapterStatusLabel(left).localeCompare(chapterStatusLabel(right), "zh-CN"))
        .map((value) => ({ value, label: chapterStatusLabel(value) })),
    [volumes],
  );

  if (!volumes.length)
    return (
      <>
        <PageHeader
          eyebrow="正文索引"
          title="浏览全书章节"
          description="按卷查看完整章节结构，并进入单章阅读。"
          actions={
            <Button className="button-link" component={Link} to={newVolumeHref} variant="outline">
              新建卷
            </Button>
          }
        />
        <Panel>
          <EmptyState label="当前小说还没有卷" detail="使用“新建卷”创建第一卷；写入前会先展示完整预览。" />
        </Panel>
      </>
    );

  return (
    <>
      <PageHeader
        eyebrow="正文索引"
        title="浏览全书章节"
        description="每卷独立折叠；展开后显示该卷全部章节，点击章节进入连续阅读。"
        actions={
          <Button className="button-link" component={Link} to={newVolumeHref} variant="outline">
            新建卷
          </Button>
        }
      />
      <Panel className="chapter-browser">
        <div className="chapter-controls">
          <SelectField
            label="状态"
            value={status}
            options={[{ value: "all", label: "全部状态" }, ...statuses]}
            onValueChange={setStatus}
          />
          <Input
            aria-label="筛选章节"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按章号、标题或状态筛选"
          />
        </div>
        {visibleResults.length ? (
          <Collapse
            multiple
            activeKey={filteredExpandedIds}
            onChange={(activeKey) => {
              if (filtered) return;
              const next = normalizeExpandedKeys(activeKey);
              setExpandedVolumeIds(next);
              writeExpandedVolumeIds(localStorage, repositoryRoot, next);
            }}
            variant="outlined"
          >
            {visibleResults.map(({ volume, chapters }) => (
              <CollapsibleVolumeSection key={volume.id} volume={volume} chapters={chapters} filtered={filtered} />
            ))}
          </Collapse>
        ) : (
          <EmptyState label="没有匹配的章节" detail="请调整关键词或状态筛选。" />
        )}
      </Panel>
    </>
  );
}
