import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = fileURLToPath(
  new URL("../../client/src/styles.css", import.meta.url),
);
const automationPagePath = fileURLToPath(
  new URL(
    "../../client/src/features/automation/AutomationPage.tsx",
    import.meta.url,
  ),
);
const workflowStepsPath = fileURLToPath(
  new URL(
    "../../client/src/features/workflow/WorkflowSteps.tsx",
    import.meta.url,
  ),
);
const workflowPagePath = fileURLToPath(
  new URL(
    "../../client/src/features/workflow/WorkflowPage.tsx",
    import.meta.url,
  ),
);
const workbenchShellPath = fileURLToPath(
  new URL("../../client/src/app/WorkbenchShell.tsx", import.meta.url),
);
const libraryThemePath = fileURLToPath(
  new URL("../../client/src/app/theme.ts", import.meta.url),
);

describe("工作台主题令牌", () => {
  it("不覆盖组件库保留的 accent 令牌", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).not.toMatch(/^\s*--accent\s*:/m);
    expect(styles).toMatch(/^\s*--workbench-accent\s*:/m);
  });

  it("深墨黑通过根节点外观标记覆盖工作台令牌", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toMatch(/:root\[data-appearance=["']modern["']\]\s*\{/);
    expect(styles).toMatch(
      /:root\[data-appearance=["']modern["']\][\s\S]*--paper:\s*#0d1117/,
    );
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it("主题样式只覆盖颜色和装饰表面，共用布局与组件尺寸", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const theme = readFileSync(libraryThemePath, "utf8");
    const themeRules = [
      ...styles.matchAll(
        /:root\[data-appearance="(?:modern|sky)"\][^{]*\{([^}]*)\}/g,
      ),
    ];

    expect(themeRules.length).toBeGreaterThan(0);
    for (const [, declarations] of themeRules) {
      const properties = declarations.matchAll(/^\s*([\w-]+):/gm);
      for (const [, property] of properties) {
        expect(property).toMatch(
          /^(?:--(?!radius\b)[\w-]+|color|background(?:-attachment)?|border-(?:bottom-)?color|box-shadow)$/,
        );
      }
    }
    expect(theme).not.toMatch(/\b(?:radii|shadows|zIndex):/);
  });

  it("三种外观共享顶部栏选择器容器尺寸", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const sharedRule = styles.match(/\.appearance-select\s*\{([^}]*)\}/)?.[1];

    expect(sharedRule).toMatch(/padding-right:\s*18px/);
    expect(sharedRule).toMatch(/border-right:\s*1px solid var\(--line\)/);
    expect(styles).not.toMatch(
      /:root\[data-appearance=["']modern["']\]\s+\.appearance-select\s*\{/,
    );
  });

  it("侧栏导航悬停保持位置，避免触发横向滚动", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const hoverRules = [
      ...styles.matchAll(/\.sidebar nav a:hover\s*\{([^}]*)\}/g),
    ];

    expect(hoverRules.length).toBeGreaterThan(0);
    for (const [, declarations] of hoverRules) {
      expect(declarations).not.toMatch(/(?:^|;)\s*(?:transform|translate)\s*:/);
    }
  });

  it("深墨黑为安全边界 Alert 使用独立的冷色信息表面", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const automationPage = readFileSync(automationPagePath, "utf8");

    expect(automationPage).toContain('className="automation-boundary-alert"');
    expect(automationPage).toContain(
      'className="automation-boundary-alert-description"',
    );
    expect(styles).toMatch(
      /:root\[data-appearance=["']modern["']\]\s+\.automation-boundary-alert\s*\{[^}]*background:\s*#111c27;[^}]*border-color:\s*#38546b;/s,
    );
    expect(styles).toMatch(
      /\.automation-boundary-alert-description\s*\{[^}]*color:\s*#aab6c2;/s,
    );
  });

  it("第八步使用分层摘要和有间距的最终写入操作区", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const workflowSteps = readFileSync(workflowStepsPath, "utf8");
    const writePathsRule = styles.match(/\.write-paths\s*\{([^}]*)\}/)?.[1];
    const commitActionsRule = styles.match(
      /\.write-commit-actions\s*\{([^}]*)\}/,
    )?.[1];

    expect(workflowSteps).toContain('className="write-commit-actions"');
    expect(writePathsRule).toMatch(/display:\s*grid/);
    expect(writePathsRule).toMatch(/grid-template-columns:/);
    expect(writePathsRule).toMatch(/gap:/);
    expect(styles).toMatch(/\.write-paths dd\s*\{[^}]*margin:\s*0;/s);
    expect(commitActionsRule).toMatch(/display:\s*grid/);
    expect(commitActionsRule).toMatch(/gap:\s*12px/);
  });

  it("第八、九步使用共享的响应式下一步操作区", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const workflowSteps = readFileSync(workflowStepsPath, "utf8");
    const actionPromptRule = styles.match(
      /\.workflow-action-prompt\s*\{([^}]*)\}/,
    )?.[1];

    expect(
      workflowSteps.match(/className="workflow-action-prompt"/g),
    ).toHaveLength(2);
    expect(workflowSteps).toContain('className="workflow-action-prompt-copy"');
    expect(workflowSteps).toContain("先生成只读预览");
    expect(workflowSteps).toContain("归档本轮生产工件");
    expect(workflowSteps).toContain("原任务链接仍可只读查看");
    expect(actionPromptRule).toMatch(/display:\s*grid/);
    expect(actionPromptRule).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.workflow-action-prompt\s*\{[^}]*grid-template-columns:\s*1fr;/s,
    );
  });

  it("工作流为长步骤和移动端进度提供专用布局", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const workflowSteps = readFileSync(workflowStepsPath, "utf8");
    const workflowPage = readFileSync(workflowPagePath, "utf8");
    const shell = readFileSync(workbenchShellPath, "utf8");

    expect(workflowSteps).toContain('className="workflow-handoff-grid"');
    expect(
      workflowSteps.match(/className="workflow-handoff-panel"/g),
    ).toHaveLength(4);
    expect(workflowPage).toContain('className="workflow-page"');
    expect(shell).toContain("page-content-workflow");
    expect(shell).toContain("page-content-workflow-handoff");
    expect(workflowSteps).toContain("workflow-step-actions-sticky");
    expect(styles).toMatch(
      /\.workflow-handoff-grid\s*\{[^}]*grid-template-columns:/s,
    );
    expect(styles).toMatch(
      /\.page-content-workflow\s*\{[^}]*min-height:\s*100%/s,
    );
    expect(styles).toMatch(
      /\.page-content-workflow-handoff\s*\{[^}]*height:\s*max\(640px,\s*100%\)/s,
    );
    expect(styles).toMatch(
      /\.workflow-handoff-grid\s*\{[^}]*height:\s*100%[^}]*align-items:\s*stretch/s,
    );
    expect(styles).toMatch(
      /\.workflow-handoff-grid\s*>\s*\.workflow-handoff-panel\s*\{[^}]*height:\s*100%[^}]*display:\s*flex/s,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.stage-rail ol:not\(\.expanded\)\s*\{[^}]*display:\s*none;/s,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.workflow-handoff-grid\s*\{[^}]*grid-template-columns:\s*1fr;/s,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.page-content-workflow\s*\{[^}]*min-height:\s*0;/s,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*\.page-content-workflow-handoff\s*\{[^}]*height:\s*auto;/s,
    );
  });

  it("四级严重度标签具有可辨认的递减视觉层级", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const blockerRule = styles.match(
      /\.severity-chip\.severity-chip-blocker\s*\{([^}]*)\}/,
    )?.[1];
    const importantRule = styles.match(
      /\.severity-chip\.severity-chip-important\s*\{([^}]*)\}/,
    )?.[1];
    const minorRule = styles.match(
      /\.severity-chip\.severity-chip-minor\s*\{([^}]*)\}/,
    )?.[1];
    const optionalRule = styles.match(
      /\.severity-chip\.severity-chip-optional\s*\{([^}]*)\}/,
    )?.[1];

    expect(blockerRule).toMatch(/color:\s*#fff/);
    expect(blockerRule).not.toMatch(/background:/);
    expect(blockerRule).not.toMatch(/border-color:/);
    expect(importantRule).toMatch(/color:\s*#fff/);
    expect(importantRule).not.toMatch(/background:/);
    expect(importantRule).not.toMatch(/border-color:/);
    expect(minorRule).toMatch(/color:\s*var\(--ink-secondary\)/);
    expect(minorRule).toMatch(/background:/);
    expect(minorRule).toMatch(/border-color:/);
    expect(optionalRule).toMatch(/color:\s*var\(--muted\)/);
    expect(optionalRule).toMatch(/background:/);
    expect(optionalRule).toMatch(/border-color:/);
  });
});
