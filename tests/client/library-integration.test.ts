import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string) {
  return readFileSync(
    fileURLToPath(new URL(`../../client/src/${relativePath}`, import.meta.url)),
    "utf8",
  );
}

function readClientFile(relativePath: string) {
  return readFileSync(
    fileURLToPath(new URL(`../../client/${relativePath}`, import.meta.url)),
    "utf8",
  );
}

describe("组件库集成边界", () => {
  it("通过 ThemeProvider 为三种外观提供独立主题", () => {
    const main = readSource("main.tsx");
    const theme = readSource("app/theme.ts");

    expect(main).toContain("ThemeProvider");
    expect(main).toContain("ToastProvider");
    expect(main).toContain("workbenchThemes");
    expect(main).toContain("AppearanceProvider");
    expect(theme).toMatch(/primary:\s*["']#9e3f2d["']/);
    expect(theme).toContain("modern:");
    expect(theme).toContain("sky:");
    expect(theme).toMatch(/background:\s*["']#0d1117["']/);
  });

  it("顶部栏外观切换复用组件库 Select", () => {
    const shell = readSource("app/WorkbenchShell.tsx");
    const appearanceSelect = readSource("app/AppearanceSelect.tsx");

    expect(shell).toContain("<AppearanceSelect");
    expect(appearanceSelect).toMatch(
      /import\s*\{[^}]*\bSelect\b[^}]*\}\s*from\s*["']@ldkj\/web-ui["']/s,
    );
    expect(appearanceSelect).toContain(
      "<SelectItems options={APPEARANCE_OPTIONS} />",
    );
    expect(appearanceSelect).toContain('className="appearance-select-trigger"');
  });

  it("侧栏的新建入口复用 Button 和 Icon，版本反馈复用 Chip", () => {
    const shell = readSource("app/WorkbenchShell.tsx");
    const sidebar = shell.match(/<aside\b[\s\S]*?<\/aside>/)?.[0];
    const imports = shell
      .match(/import\s*\{([^}]*)\}\s*from "@ldkj\/web-ui"/)?.[1]
      ?.split(",")
      .map((item) => item.trim());
    expect(imports).toEqual(expect.arrayContaining(["Button", "Chip", "Icon"]));
    expect(sidebar).toMatch(
      /<Button\b[^>]*className="sidebar-create"[\s\S]*?<Icon name="add"[^>]*\/>\s*新建小说\s*<\/Button>/,
    );
    expect(shell).toMatch(/<Chip\s+className="sync-state"/);
  });

  it("业务筛选只使用共享 SelectField，不保留原生 select", () => {
    const chapters = readSource("features/chapters/ChaptersPage.tsx");
    const issues = readSource("features/workflow/ReviewIssueList.tsx");

    expect(chapters).not.toMatch(/<select\b/i);
    expect(issues).not.toMatch(/<select\b/i);
    expect(chapters).toContain("SelectField");
    expect(issues).toContain("SelectField");
  });

  it("章节总览使用组件库 Collapse，且不再用下拉框切换卷", () => {
    const page = readSource("features/chapters/ChaptersPage.tsx");
    const section = readSource(
      "features/chapters/CollapsibleVolumeSection.tsx",
    );

    expect(page).toMatch(
      /import\s*\{[^}]*\bCollapse\b[^}]*\}\s*from\s*["']@ldkj\/web-ui["']/s,
    );
    expect(section).toContain("<Collapse.Item");
    expect(page).not.toContain('label="卷"');
  });

  it("详情页通过组件库 Breadcrumb 保持深链接层级", () => {
    const breadcrumb = readSource("components/BreadcrumbTrail.tsx");
    const chapter = readSource("features/chapters/ChapterDetailPage.tsx");
    const volume = readSource("features/volumes/VolumeDetailPage.tsx");
    const document = readSource("features/documents/DocumentDetailPage.tsx");

    expect(breadcrumb).toMatch(
      /import\s*\{[^}]*\bBreadcrumb\b[^}]*\}\s*from\s*["']@ldkj\/web-ui["']/s,
    );
    expect(chapter).toContain("<BreadcrumbTrail");
    expect(volume).toContain("<BreadcrumbTrail");
    expect(document).toContain("<BreadcrumbTrail");
  });

  it("空状态显式使用工作台 SVG，不回退到组件库默认图标", () => {
    const states = readSource("components/states.tsx");

    expect(states).toMatch(/import\s+emptyImage\s+from\s+["'].+empty\.svg["']/);
    expect(states).toMatch(/<Empty[\s\S]*image=\{[\s\S]*emptyImage/);
  });

  it("工作流错误提示与下方内容保持间距", () => {
    const page = readSource("features/workflow/WorkflowPage.tsx");
    const styles = readSource("styles.css");

    expect(page).toContain('className="workflow-error"');
    expect(styles).toMatch(/\.workflow-error\s*\{[^}]*margin-bottom:/s);
  });

  it("工作流本地草稿接入统一的离开保护", () => {
    const page = readSource("features/workflow/WorkflowPage.tsx");

    expect(page).toContain("useUnsavedChangesGuard");
  });

  it("Dashboard 使用组件库 Grid 承担指标区和卡片区布局", () => {
    const dashboard = readSource("features/dashboard/DashboardPage.tsx");
    const styles = readSource("styles.css");

    expect(dashboard).toMatch(
      /import\s*\{[^}]*\bGrid\b[^}]*\}\s*from\s*["']@ldkj\/web-ui["']/s,
    );
    expect(dashboard.match(/<Grid\s+container\b/g)).toHaveLength(2);
    expect(dashboard).toMatch(
      /<Grid[\s\S]*columns=\{12\}[\s\S]*spacing=["']18px["'][\s\S]*className=["']dashboard-grid["']/,
    );
    expect(dashboard).toContain(
      '<Grid size="grow" className="dashboard-grid-item">',
    );
    expect(styles).not.toMatch(/\.metric-strip\s*\{[^}]*display:\s*grid/s);
    expect(styles).not.toMatch(/\.dashboard-grid\s*\{[^}]*display:\s*grid/s);
  });

  it("前端入口使用工作台 favicon", () => {
    const index = readClientFile("index.html");

    expect(index).toMatch(
      /<link\s+[^>]*rel=["']icon["'][^>]*href=["']\/src\/assets\/favicon\.png["'][^>]*>/,
    );
  });

  it("Dashboard 卷进度使用组件库 Progress", () => {
    const dashboard = readSource("features/dashboard/DashboardPage.tsx");
    const styles = readSource("styles.css");

    expect(dashboard).toMatch(
      /import\s*\{[^}]*\bProgress\b[^}]*\}\s*from\s*["']@ldkj\/web-ui["']/s,
    );
    expect(dashboard).toMatch(/<Progress[\s\S]*value=\{volume\.finalCount\}/);
    expect(dashboard).toMatch(/<Progress[\s\S]*max=\{volume\.chapterCount\}/);
    expect(styles).not.toContain(".volume-track");
  });

  it("全局页面快捷操作使用组件库 GhostButtonGroup", () => {
    const shell = readSource("app/WorkbenchShell.tsx");
    const actions = readSource("components/GlobalQuickActions.tsx");

    expect(shell).toContain("<GlobalQuickActions");
    expect(actions).toMatch(
      /import\s*\{[^}]*\bGhostButtonGroup\b[^}]*\}\s*from\s*["']@ldkj\/web-ui["']/s,
    );
    expect(actions).toContain('itemKey: "reload"');
    expect(actions).toContain('itemKey: "scroll-top"');
  });

  it("Git 文件列表使用共享 ScrollArea 限制为 20 个标准行", () => {
    const page = readSource("features/git/GitPage.tsx");

    expect(page).toMatch(
      /import\s*\{\s*ScrollArea\s*\}\s*from\s*["'].+components\/ScrollArea["']/,
    );
    expect(page).toContain("GIT_FILE_VISIBLE_ROWS = 20");
    expect(page).toMatch(
      /<ScrollArea[\s\S]*aria-label=["']发生变化的文件列表["'][\s\S]*maxHeight=\{GIT_FILE_VISIBLE_ROWS \* GIT_FILE_ROW_HEIGHT\}/,
    );
  });

  it("卷管理复用组件库表单、输入、确认和反馈组件", () => {
    const form = readSource("features/volumes/VolumeForm.tsx");
    const archive = readSource("features/volumes/VolumeArchivePanel.tsx");
    const preview = readSource("components/MutationPreviewDialog.tsx");

    expect(form).toMatch(
      /import\s*\{[^}]*\bForm\b[^}]*\bInput\b[^}]*\}\s*from\s*["']@ldkj\/web-ui["']/s,
    );
    expect(archive).toMatch(
      /import\s*\{[^}]*\bAlert\b[^}]*\bInput\b[^}]*\}\s*from\s*["']@ldkj\/web-ui["']/s,
    );
    expect(preview).toMatch(
      /import\s*\{[^}]*\bButton\b[^}]*\bCheckbox\b[^}]*\bDialog\b[^}]*\}\s*from\s*["']@ldkj\/web-ui["']/s,
    );
  });

  it("按钮式站内导航使用 Button 的 Link 多态能力，不嵌套交互元素", () => {
    const actionSources = [
      "features/chapters/ChaptersPage.tsx",
      "features/chapters/CollapsibleVolumeSection.tsx",
      "features/dashboard/DashboardPage.tsx",
      "features/documents/DocumentCreatePage.tsx",
      "features/documents/DocumentDetailPage.tsx",
      "features/documents/DocumentsPage.tsx",
      "features/documents/NovelMetadataPage.tsx",
      "features/volumes/VolumeDetailPage.tsx",
      "features/workflow/WorkflowPage.tsx",
    ].map(readSource);

    for (const source of actionSources) {
      expect(source).not.toMatch(/<Link\b[^>]*>\s*<Button\b/s);
    }

    const combinedSource = actionSources.join("\n");
    for (const label of [
      "返回章节总览",
      "编辑卷资料",
      "卷末新建章节",
      "新建卷",
      "查看卷详情",
      "返回文档库",
      "小说元数据",
      "新建文档",
      "阅读文档",
      "继续当前任务",
      "选择待验收章节",
      "进入向导",
      "查看版本与文件",
      "返回本章",
      "选择下一章",
    ]) {
      expect(combinedSource).toMatch(
        new RegExp(
          `<Button(?=[^>]*component=\\{Link\\})(?=[^>]*variant=["']outline["'])[^>]*>(?:(?!<\\/Button>)[\\s\\S])*?${label}(?:(?!<\\/Button>)[\\s\\S])*?<\\/Button>`,
        ),
      );
    }
  });

  it("默认文本链接使用主题强调色，悬停显示下划线，按钮式链接始终无下划线", () => {
    const styles = readSource("styles.css");

    expect(styles).toMatch(
      /(?:^|\n)a\s*\{[^}]*color:\s*var\(--workbench-accent\)/,
    );
    expect(styles).toMatch(/a\s*\{[^}]*text-decoration:\s*none/s);
    expect(styles).toMatch(/a:hover\s*\{[^}]*text-decoration:\s*underline/s);
    expect(styles).toMatch(
      /\.button-link,\s*\.button-link:hover\s*\{[^}]*text-decoration:\s*none/s,
    );
  });

  it("mutation 预览内容受小屏视口高度约束并在内部滚动", () => {
    const preview = readSource("components/MutationPreviewDialog.tsx");
    const styles = readSource("styles.css");

    expect(preview).toMatch(
      /<Dialog\.Content\s+className=["']mutation-preview-dialog-content["']/,
    );
    expect(styles).toMatch(
      /\.mutation-preview-dialog-content\s*\{[^}]*max-(?:block-size|height):\s*calc\(100dvh\s*-\s*32px\)[^}]*overflow-y:\s*auto/s,
    );
  });
});
