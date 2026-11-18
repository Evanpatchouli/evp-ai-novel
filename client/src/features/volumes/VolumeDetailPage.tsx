import { useEffect, useState } from "react";
import { Alert, Button, Chip } from "@ldkj/web-ui";
import { Link, useParams } from "react-router";
import type { VolumeDetail } from "../../../../shared/contracts";
import { chapterHref, volumeHref } from "../../../../shared/reader-paths";
import { api } from "../../api";
import { BreadcrumbTrail } from "../../components/BreadcrumbTrail";
import { PageHeader, Panel } from "../../components/layout";
import { EmptyState, ErrorState, LoadingState } from "../../components/states";
import { chapterDetailHref } from "../chapters/chapterNavigation";
import { StatusChip } from "../chapters/ChapterRow";
import {
  lifecycleLabel,
  presentStatusCounts,
  relatedRecordKindLabel,
} from "./volumePresentation";
import { VolumeArchivePanel } from "./VolumeArchivePanel";

type ManagedVolumeDetail = VolumeDetail;

function documentHref(path: string): string {
  return `/documents/view?path=${encodeURIComponent(path)}`;
}

export function VolumeDetailPage() {
  const { volumeId = "" } = useParams();
  const [volume, setVolume] = useState<ManagedVolumeDetail | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setVolume(null);
    setBusy(true);
    setError("");
    void api
      .volume(volumeId)
      .then((loaded) => {
        if (!cancelled) setVolume(loaded);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "无法读取卷详情");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [volumeId]);

  if (busy) return <LoadingState label="正在读取卷详情" />;
  if (error || !volume)
    return (
      <>
        <PageHeader
          eyebrow={volumeId || "卷详情"}
          title="无法打开这一卷"
          description="当前地址中的卷不属于所选仓库。"
        />
        <ErrorState message={error || "卷详情不存在"} />
      </>
    );

  const statuses = presentStatusCounts(volume.statusCounts);
  const currentChapter = volume.chapters.find(
    (chapter) => chapter.id === volume.currentChapterId,
  );
  return (
    <div className="volume-detail-page">
      <BreadcrumbTrail
        items={[
          { label: "章节总览", to: "/chapters" },
          { label: `第 ${volume.number} 卷 · ${volume.title}` },
        ]}
      />
      <PageHeader
        eyebrow={`第 ${volume.number} 卷 · ${volume.id}`}
        title={volume.title}
        description={`${lifecycleLabel(volume.lifecycleStatus)} · ${volume.chapterCount.toLocaleString()} 章 · ${volume.totalWordCount.toLocaleString()} 字`}
        actions={
          <div className="inline-actions">
            <Button
              className="button-link"
              component={Link}
              to="/chapters"
              size="sm"
              variant="outline"
            >
              返回章节总览
            </Button>
            <Button
              className="button-link"
              component={Link}
              to={`${volumeHref(volume.id)}/edit`}
              size="sm"
              variant="outline"
            >
              编辑卷资料
            </Button>
            <Button
              className="button-link"
              component={Link}
              to={chapterHref(volume.id, "new")}
              size="sm"
              variant="outline"
            >
              卷末新建章节
            </Button>
          </div>
        }
      />

      {volume.healthIssues.map((issue, index) => (
        <Alert
          key={`${issue.code}-${issue.path ?? index}`}
          variant={issue.severity === "blocking" ? "error" : "warning"}
          showIcon
          title={issue.message}
          description={issue.path}
        />
      ))}

      <Panel title="卷概览" description="统计来自正文与权威状态表。">
        <dl className="volume-stats">
          <div>
            <dt>章节</dt>
            <dd>{volume.chapterCount.toLocaleString()} 章</dd>
          </div>
          <div>
            <dt>总字数</dt>
            <dd>{volume.totalWordCount.toLocaleString()} 字</dd>
          </div>
          <div>
            <dt>首章</dt>
            <dd>
              {volume.firstChapter ? (
                <Link to={chapterDetailHref(volume.firstChapter)}>
                  {volume.firstChapter.title}
                </Link>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>末章</dt>
            <dd>
              {volume.lastChapter ? (
                <Link to={chapterDetailHref(volume.lastChapter)}>
                  {volume.lastChapter.title}
                </Link>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>当前处理</dt>
            <dd>
              {currentChapter ? (
                <Link
                  to={chapterDetailHref({
                    volumeId: volume.id,
                    volumeNumber: volume.number,
                    chapterId: currentChapter.id,
                    chapterNumber: currentChapter.number,
                    title: currentChapter.title,
                  })}
                >
                  {currentChapter.title}
                </Link>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
        {statuses.length ? (
          <ul className="status-counts" aria-label="章节状态统计">
            {statuses.map((item) => (
              <li key={item.status}>
                <StatusChip status={item.status} />
                <strong>{item.count.toLocaleString()}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-copy">本卷尚无章节状态。</p>
        )}
        {volume.outline ? (
          <p>
            <Link to={documentHref(volume.outline.path)}>
              阅读卷纲：{volume.outline.title}
            </Link>
          </p>
        ) : (
          <p className="muted-copy">尚未建立卷纲。</p>
        )}
      </Panel>

      <Panel title="完整章节" description="章节按全书章号排列，不分页。">
        {volume.chapters.length ? (
          <ol className="volume-chapter-list">
            {volume.chapters.map((chapter) => (
              <li
                key={chapter.id}
                className={
                  chapter.id === volume.currentChapterId
                    ? "current-chapter"
                    : undefined
                }
              >
                <Link
                  to={chapterDetailHref({
                    volumeId: volume.id,
                    volumeNumber: volume.number,
                    chapterId: chapter.id,
                    chapterNumber: chapter.number,
                    title: chapter.title,
                  })}
                >
                  <span>第 {String(chapter.number).padStart(3, "0")} 章</span>
                  <strong>
                    {chapter.title}
                    {chapter.id === volume.currentChapterId && (
                      <span className="current-marker">当前处理</span>
                    )}
                  </strong>
                  <small>{chapter.wordCount.toLocaleString()} 字</small>
                  <StatusChip status={chapter.status} />
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState
            label="这一卷还没有章节"
            detail="可以从卷末新建第一章；章 ID 仍按全书历史最大编号递增。"
          />
        )}
      </Panel>

      <Panel title="相关记录" description="审稿、生产与发布记录均为只读入口。">
        {volume.relatedRecords.length ? (
          <ul className="related-records">
            {volume.relatedRecords.map((record) => (
              <li key={`${record.kind}-${record.path}`}>
                <Chip size="sm">{relatedRecordKindLabel(record.kind)}</Chip>
                <Link to={documentHref(record.path)}>{record.title}</Link>
                <small>{record.path}</small>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState label="暂无相关记录" />
        )}
      </Panel>
      <VolumeArchivePanel volume={volume} />
    </div>
  );
}
