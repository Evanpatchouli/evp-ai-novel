import { useEffect, useState } from "react";
import { Chip, Form, Input } from "@ldkj/web-ui";
import { api, type NovelVersion } from "../../api";
import { useRepositorySession } from "../../app/RepositorySession";
import { AsyncButton } from "../../components/AsyncButton";
import { CopyButton } from "../../components/CopyButton";
import { PageHeader, Panel } from "../../components/layout";
import { ScrollArea } from "../../components/ScrollArea";
import { EmptyState } from "../../components/states";

const GIT_FILE_VISIBLE_ROWS = 20;
const GIT_FILE_ROW_HEIGHT = 39;

export function GitPage() {
  const { dashboard, showNotice, refreshDashboard } = useRepositorySession();
  const [git, setGit] = useState(() => dashboard?.git ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [versions, setVersions] = useState<NovelVersion[]>([]);
  useEffect(() => { void api.versions().then(setVersions).catch((cause: unknown) => showNotice({ tone: "error", message: cause instanceof Error ? cause.message : "读取版本失败" })); }, [dashboard?.repositoryRoot]);

  if (!git)
    return (
      <EmptyState
        label="尚未读取仓库状态"
        detail="选择小说仓库后即可查看 Git 状态。"
      />
    );

  const refresh = async () => {
    setBusy(true);
    try {
      const [status, history] = await Promise.all([api.git(), api.versions()]);
      setGit(status); setVersions(history);
    } catch (cause) {
      showNotice({
        tone: "error",
        message: cause instanceof Error ? cause.message : "刷新 Git 状态失败",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="小说版本管理"
        title={
          git.clean
            ? "工作区没有未提交修改"
            : `有 ${git.changes.length} 项修改尚未提交`
        }
        description={`当前分支 ${git.branch}，领先 ${git.ahead}，落后 ${git.behind}。版本保存在本地 Git 仓库中。`}
        actions={
          <AsyncButton
            variant="outline"
            busy={busy}
            onClick={() => void refresh()}
          >
            刷新状态
          </AsyncButton>
        }
      />
      <div className="git-layout">
        <Panel title="保存版本" description="将当前小说文件保存为一个本地版本。">
          <Form onSubmit={(event) => {
            event.preventDefault();
            if (!message.trim()) return;
            setBusy(true);
            void api.createVersion(message.trim()).then(async () => {
              setMessage("");
              const [status, history] = await Promise.all([api.git(), api.versions()]);
              setGit(status); setVersions(history);
              await refreshDashboard();
              showNotice({ tone: "success", message: "小说版本已保存。" });
            }).catch((cause: unknown) => showNotice({ tone: "error", message: cause instanceof Error ? cause.message : "保存版本失败" })).finally(() => setBusy(false));
          }}>
            <Form.Item label="版本说明" required><Input aria-label="版本说明" value={message} maxLength={200} onChange={(event) => setMessage(event.target.value)} /></Form.Item>
            <AsyncButton type="submit" busy={busy} disabled={!message.trim() || git.clean}>保存版本</AsyncButton>
          </Form>
        </Panel>
        <Panel title="版本历史" description="最近 100 个本地版本">
          {versions.length ? <ul className="plain-status">{versions.map((version) => <li key={version.id}><strong>{version.message}</strong> <small>{new Date(version.date).toLocaleString()} · {version.id.slice(0, 8)}</small></li>)}</ul> : <EmptyState label="还没有保存版本" />}
        </Panel>
        <Panel title="普通语言说明">
          <ul className="plain-status">
            {git.plainLanguage.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </Panel>
        <Panel
          title="建议提交信息"
          action={
            <CopyButton text={git.suggestedCommitMessage} notify={showNotice} />
          }
        >
          <pre className="command-block">{git.suggestedCommitMessage}</pre>
        </Panel>
        <Panel title="发生变化的文件" className="git-files">
          {git.changes.length ? (
            <ScrollArea
              aria-label="发生变化的文件列表"
              maxHeight={GIT_FILE_VISIBLE_ROWS * GIT_FILE_ROW_HEIGHT}
              className="file-table"
            >
              {git.changes.map((change) => (
                <div key={change.path}>
                  <code>{change.code}</code>
                  <span>{change.path}</span>
                  {change.generatedRisk && (
                    <Chip size="sm" variant="danger">
                      生成文件风险
                    </Chip>
                  )}
                </div>
              ))}
            </ScrollArea>
          ) : (
            <EmptyState label="没有文件变化" />
          )}
        </Panel>
        <Panel title="可复制命令" description="请在外部终端检查后执行。">
          {git.suggestedCommands.map((command) => (
            <div className="command-row" key={command}>
              <code>{command}</code>
              <CopyButton text={command} notify={showNotice} compact />
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}
