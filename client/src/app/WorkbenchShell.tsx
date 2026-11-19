import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Button, Chip, Dialog, Form, Icon, Input } from "@ldkj/web-ui";
import type { ManagedNovel } from "../api";
import { Textarea } from "../components/Textarea";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { AsyncButton } from "../components/AsyncButton";
import { GlobalQuickActions } from "../components/GlobalQuickActions";
import { NoticeBanner } from "../components/NoticeBanner";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { RepositorySessionProvider, useRepositorySession } from "./RepositorySession";
import { UnsavedChangesProvider, useUnsavedChanges } from "./UnsavedChangesContext";
import { PageQuickActionsProvider } from "./PageQuickActionsContext";
import { AppearanceSelect } from "./AppearanceSelect";
import { NovelPicker } from "./NovelPicker";
import { useMainViewScroll } from "./useMainViewScroll";

const NAV = [
  { to: "/", label: "总览", hint: "工程进度", end: true },
  { to: "/chapters", label: "章节", hint: "选择正文", end: false },
  { to: "/workflow", label: "终稿验收", hint: "九阶段向导", end: false },
  { to: "/documents", label: "文档", hint: "分级浏览", end: false },
  { to: "/novel", label: "小说资料", hint: "结构化元数据", end: false },
  { to: "/git", label: "版本管理", hint: "Git 版本", end: false },
  { to: "/automation", label: "自动化", hint: "能力接口", end: false },
  { to: "/archive", label: "回收站", hint: "恢复归档资产", end: false },
] as const;

export function WorkbenchShell() {
  return (
    <RepositorySessionProvider>
      <UnsavedChangesProvider>
        <PageQuickActionsProvider>
          <WorkbenchLayout />
        </PageQuickActionsProvider>
      </UnsavedChangesProvider>
    </RepositorySessionProvider>
  );
}

function WorkbenchLayout() {
  const session = useRepositorySession();
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [returnHome, setReturnHome] = useState(false);
  const createTrigger = useRef<HTMLButtonElement | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const { requestDiscard, hasUnsavedChanges } = useUnsavedChanges();
  const { hostRef, viewportRef, contentRef, scrollToTop } = useMainViewScroll();
  const location = useLocation();
  const navigate = useNavigate();
  const isWorkflowPage = location.pathname === "/workflow" || location.pathname.startsWith("/workflow/");
  const isFullHeightWorkflow =
    isWorkflowPage && (session.task?.stage === "context-ready" || session.task?.stage === "decisions-recorded");
  const workflowPath = session.task ? `/workflow/${encodeURIComponent(session.task.id)}` : "/workflow";
  const git = session.loading || session.error ? null : session.dashboard?.git;

  useEffect(() => {
    if (!returnHome) return;
    setReturnHome(false);
    void navigate("/", { replace: true });
  }, [returnHome, navigate]);

  const selectRepository = async (id: string) => {
    if (id === session.selectedId || !(await requestDiscard())) return;
    if (await session.selectRepository(id)) navigate("/");
  };
  const deleteNovel = async (novel: ManagedNovel) => {
    const deletingSelected = novel.id === session.selectedId;
    const remainingPath = await session.deleteNovel(novel.id);
    session.showNotice(remainingPath
      ? { tone: "error", message: `《${novel.title}》已移出书库，部分文件未能删除。剩余路径：${remainingPath}` }
      : { tone: "success", message: `已永久删除《${novel.title}》。` });
    if (deletingSelected) setReturnHome(true);
  };
  const openCreateNovel = (event: MouseEvent<HTMLButtonElement>) => {
    createTrigger.current = event.currentTarget;
    setCreateOpen(true);
  };
  const createNovel = async () => {
    if (!title.trim() || !author.trim() || !(await requestDiscard())) return;
    setCreating(true);
    try {
      if (await session.createNovel(title.trim(), author.trim(), description)) {
        setCreateOpen(false);
        setTitle("");
        setAuthor("");
        setDescription("");
        navigate("/");
      }
    } finally {
      setCreating(false);
    }
  };

  const content = session.loading ? (
    <LoadingState />
  ) : session.error ? (
    <ErrorState message={session.error} onRetry={() => void session.loadDashboard()} />
  ) : !session.dashboard ? (
    session.novels.length ? (
      <EmptyState label="请选择小说" detail="从顶部选择一本小说，继续创作。" />
    ) : (
      <EmptyState label="书库中还没有小说" detail="点击「新建小说」，开始你的第一部作品。" />
    )
  ) : (
    <Outlet key={session.dashboard.repositoryRoot} />
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">文</span>
          <div>
            <strong>evp-ai-novel</strong>
            <small>本地创作工作台</small>
          </div>
        </div>
        <nav aria-label="工作台主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to === "/workflow" ? workflowPath : item.to}
              end={item.end}
              onClick={session.clearNotice}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </NavLink>
          ))}
        </nav>
        <Button
          type="button"
          className="sidebar-create"
          variant="outline"
          size="sm"
          rounded="md"
          aria-haspopup="dialog"
          aria-expanded={createOpen}
          onClick={openCreateNovel}
        >
          <Icon name="add" size={18} />
          新建小说
        </Button>
      </aside>
      <main className="main-shell">
        <div className="utility-bar">
          <div className="utility-novels">
            <NovelPicker
              novels={session.novels}
              selectedId={session.selectedId}
              disabled={session.loading || session.repositoryBusy}
              hasUnsavedChanges={hasUnsavedChanges}
              onSelect={(id) => void selectRepository(id)}
              onDelete={deleteNovel}
            />
            <Button
              type="button"
              className="utility-create"
              variant="ghost"
              size="icon"
              aria-label="新建小说"
              title="新建小说"
              aria-haspopup="dialog"
              onClick={openCreateNovel}
            >
              <Icon name="add" size={18} />
            </Button>
          </div>
          <div className="utility-actions">
            <AppearanceSelect />
            {git && (
              <Chip
                className="sync-state"
                size="sm"
                variant={git.clean ? "success" : git.changes.length ? "warning" : "minor"}
                outline
                title={`当前分支：${git.branch}`}
              >
                {git.clean ? "工作区干净" : git.changes.length ? `${git.changes.length} 项未提交` : "版本状态未知"}
              </Chip>
            )}
          </div>
        </div>
        {session.notice && (
          <div className="notice">
            <NoticeBanner notice={session.notice} onClose={session.clearNotice} />
          </div>
        )}
        <div
          className="main-scroll"
          ref={hostRef}
          data-overlayscrollbars-initialize=""
        >
          <div
            className="main-scroll-viewport"
            ref={viewportRef}
            role="region"
            aria-label="主视图内容"
            tabIndex={0}
          >
            <div
              className={`page-content${isWorkflowPage ? " page-content-workflow" : ""}${
                isFullHeightWorkflow ? " page-content-workflow-handoff" : ""
              }`}
              ref={contentRef}
            >
              {content}
            </div>
          </div>
        </div>
      </main>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!creating) setCreateOpen(open);
        }}
        closeOnMaskClick={!creating}
      >
        <Dialog.Content
          showClose={!creating}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            titleInput.current?.focus();
          }}
          onCloseAutoFocus={() => createTrigger.current?.focus({ preventScroll: true })}
        >
          <Dialog.Header>
            <Dialog.Title>新建小说</Dialog.Title>
            <Dialog.Description>填写基本信息，工作台会为小说创建独立的本地仓库。</Dialog.Description>
          </Dialog.Header>
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              void createNovel();
            }}
          >
            <Form.Item label="书名" required>
              <Input
                aria-label="书名"
                ref={titleInput}
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                disabled={creating}
                required
              />
            </Form.Item>
            <Form.Item label="作者" required>
              <Input
                aria-label="作者"
                value={author}
                maxLength={120}
                onChange={(event) => setAuthor(event.target.value)}
                disabled={creating}
                required
              />
            </Form.Item>
            <Form.Item label="简介">
              <Textarea
                aria-label="简介"
                value={description}
                maxLength={20000}
                onChange={(event) => setDescription(event.target.value)}
                disabled={creating}
              />
            </Form.Item>
            <AsyncButton type="submit" busy={creating} disabled={!title.trim() || !author.trim()}>
              创建小说
            </AsyncButton>
          </Form>
        </Dialog.Content>
      </Dialog>
      <GlobalQuickActions scrollToTop={scrollToTop} />
    </div>
  );
}
