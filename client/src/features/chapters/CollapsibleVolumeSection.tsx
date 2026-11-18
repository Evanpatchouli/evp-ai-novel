import { Button, Collapse } from "@ldkj/web-ui";
import { Link } from "react-router";
import type { ChapterSummary, VolumeSummary } from "../../../../shared/contracts";
import { volumeHref } from "../../../../shared/reader-paths";
import { EmptyState } from "../../components/states";
import { ChapterRow } from "./ChapterRow";

export function CollapsibleVolumeSection({
  volume,
  chapters,
  filtered,
}: {
  volume: VolumeSummary;
  chapters: ChapterSummary[];
  filtered: boolean;
}) {
  const totalWords = volume.chapters.reduce((total, chapter) => total + chapter.wordCount, 0);

  return (
    <Collapse.Item value={volume.id} className="volume-section">
      <Collapse.Header headingLevel={2} className="volume-section-header">
        <Collapse.Trigger>
          <span>
            <strong>
              第 {volume.number} 卷 · {volume.title}
            </strong>
            <span>
              {volume.chapterCount} 章 · {volume.finalCount} 章终稿 · {totalWords.toLocaleString()} 字
              {filtered ? ` · ${chapters.length} 项匹配` : ""}
            </span>
          </span>
        </Collapse.Trigger>
        <Collapse.Actions>
          <Button
            className="button-link"
            component={Link}
            to={volumeHref(volume.id)}
            size="sm"
            variant="outline"
          >
            查看卷详情
          </Button>
        </Collapse.Actions>
      </Collapse.Header>
      <Collapse.Content>
        <div className="chapter-list">
          {chapters.length ? (
            chapters.map((chapter) => <ChapterRow key={chapter.id} volumeId={volume.id} chapter={chapter} />)
          ) : (
            <EmptyState label={filtered ? "本卷没有匹配的章节" : "本卷暂无章节"} />
          )}
        </div>
      </Collapse.Content>
    </Collapse.Item>
  );
}
