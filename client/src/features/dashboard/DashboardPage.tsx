import { Alert, Button, Grid, Progress } from "@ldkj/web-ui";
import { Link } from "react-router";
import { useRepositorySession } from "../../app/RepositorySession";
import { PageHeader, Panel } from "../../components/layout";
import { EmptyState } from "../../components/states";

export function DashboardPage() {
  const { dashboard, task } = useRepositorySession();

  if (!dashboard)
    return (
      <EmptyState label="尚未选择小说仓库" detail="点击新建，开始你的第一部小说。" />
    );

  const totals = dashboard.volumes.reduce(
    (sum, volume) => ({
      chapters: sum.chapters + volume.chapterCount,
      final: sum.final + volume.finalCount,
      revised: sum.revised + volume.aiRevisedCount,
      active: sum.active + volume.inProgressCount,
    }),
    { chapters: 0, final: 0, revised: 0, active: 0 },
  );
  const percent = totals.chapters
    ? Math.round((totals.final / totals.chapters) * 100)
    : 0;

  return (
    <>
      <PageHeader
        eyebrow="小说工程总览"
        title="今天从明确的一步开始"
        description="正文、设定与生产记录保存在应用管理的小说仓库中。"
        actions={
          <Button
            className="button-link"
            component={Link}
            to={task ? `/workflow/${task.id}` : "/chapters"}
            variant="outline"
          >
            {task ? "继续当前任务" : "选择待验收章节"}
          </Button>
        }
      />
      <Grid container columns={13} spacing={0} className="metric-strip">
        <Grid size={4} className="metric feature">
          <span>全书终稿进度</span>
          <strong>
            {percent}
            <small>%</small>
          </strong>
          <p>
            {totals.final} / {totals.chapters} 章已由作者确认
          </p>
        </Grid>
        <Grid size={3} className="metric">
          <span>待人工验收</span>
          <strong>{totals.revised}</strong>
          <p>AI 修订稿</p>
        </Grid>
        <Grid size={3} className="metric">
          <span>处理中</span>
          <strong>{totals.active}</strong>
          <p>草稿或修订中</p>
        </Grid>
        <Grid size={3} className="metric">
          <span>连续性问题</span>
          <strong>{dashboard.continuity.unresolvedReviewItems}</strong>
          <p>尚未处理</p>
        </Grid>
      </Grid>
      <Grid container columns={12} spacing="18px" className="dashboard-grid">
        <Grid size={12} className="dashboard-grid-item">
          <Panel
            title="当前任务"
            description="系统只推进已获得作者确认的操作。"
            className="current-task"
          >
            {task ? (
              <div className="task-focus">
                <div>
                  <span className="task-kicker">
                    {task.volumeId} · {task.chapterId}
                  </span>
                  <h3>{task.chapter?.title ?? "单章终稿验收"}</h3>
                  <p>{task.nextAction}</p>
                </div>
                <Button
                  className="button-link"
                  component={Link}
                  to={`/workflow/${task.id}`}
                  variant="outline"
                >
                  进入向导
                </Button>
              </div>
            ) : (
              <EmptyState
                label="没有进行中的任务"
                detail="从章节页选择一章，创建独立生产任务。"
              />
            )}
          </Panel>
        </Grid>
        <Grid size={7} className="dashboard-grid-item">
          <Panel title="卷进度" description="终稿状态来自正文状态表。">
            <div className="volume-list">
              {dashboard.volumes.map((volume) => (
                <div className="volume-line" key={volume.id}>
                  <div>
                    <strong>{volume.title}</strong>
                    <span>
                      {volume.finalCount} / {volume.chapterCount} 章终稿
                    </span>
                  </div>
                  <Progress
                    value={volume.finalCount}
                    max={volume.chapterCount}
                    showInfo={false}
                    size={4}
                    strokeColor="var(--workbench-accent)"
                    trailColor="#e6e3da"
                  />
                </div>
              ))}
            </div>
          </Panel>
        </Grid>
        <Grid size="grow" className="dashboard-grid-item">
          <Panel title="连续性资料" description="只显示权威文件与未决审稿项。">
            <dl className="continuity-list">
              <div>
                <dt>人物档案</dt>
                <dd>{dashboard.continuity.characterFiles}</dd>
              </div>
              <div>
                <dt>活跃伏笔</dt>
                <dd>{dashboard.continuity.activeForeshadowFiles}</dd>
              </div>
              <div>
                <dt>时间线文件</dt>
                <dd>{dashboard.continuity.timelineFiles}</dd>
              </div>
              <div>
                <dt>未决问题</dt>
                <dd>{dashboard.continuity.unresolvedReviewItems}</dd>
              </div>
            </dl>
          </Panel>
        </Grid>
        <Grid size={7} className="dashboard-grid-item">
          <Panel
            title="仓库状态"
            description={`${dashboard.git.branch} · ${dashboard.health.healthy ? "结构健康" : `${dashboard.health.issues.length} 项结构问题`}`}
          >
            {!dashboard.health.healthy && (
              <Alert
                variant="warning"
                showIcon
                title="仓库健康检查未通过"
                description={dashboard.health.issues
                  .slice(0, 3)
                  .map((issue) => issue.message)
                  .join("；")}
              />
            )}
            <ul className="plain-status">
              {dashboard.git.plainLanguage.slice(0, 4).map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
            <Button
              className="button-link"
              component={Link}
              to="/git"
              size="sm"
              variant="outline"
            >
              查看版本与文件
            </Button>
          </Panel>
        </Grid>
      </Grid>
    </>
  );
}
