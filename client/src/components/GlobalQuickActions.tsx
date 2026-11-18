import {
  GhostButtonGroup,
  Icon,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@ldkj/web-ui";
import { useRegisteredPageQuickActions } from "../app/PageQuickActionsContext";

export interface GlobalQuickActionsProps {
  reloadPage?: () => void;
  scrollToTop?: () => void;
}

const reloadCurrentPage = () => window.location.reload();

const scrollPageToTop = () =>
  window.scrollTo({
    top: 0,
    left: 0,
    behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });

/** 全局页面快捷操作，使用组件库悬浮按钮组统一提供刷新与回到顶部。 */
export function GlobalQuickActions({
  reloadPage = reloadCurrentPage,
  scrollToTop = scrollPageToTop,
}: GlobalQuickActionsProps) {
  const pageActions = useRegisteredPageQuickActions();

  return (
    <GhostButtonGroup
      trigger="click"
      direction="up"
      gap={10}
      right={20}
      bottom={20}
      zIndex={30}
      size="sm"
      aria-label="页面快捷操作"
      title="页面快捷操作"
      items={[
        ...pageActions.map((action) => ({
          itemKey: action.itemKey,
          size: "sm" as const,
          "aria-label": action.label,
          title: action.label,
          disabled: action.disabled,
          onClick: action.onClick,
          children: (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>{action.icon}</TooltipTrigger>
                <TooltipContent
                  sx={{ transform: "translateX(-0.8rem)" }}
                  side="left"
                  arrow
                >
                  {action.label}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ),
        })),
        {
          itemKey: "reload",
          size: "sm",
          "aria-label": "刷新页面",
          title: "刷新页面",
          onClick: reloadPage,
          children: (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Icon name="refresh" size={19} />
                </TooltipTrigger>
                <TooltipContent
                  sx={{ transform: "translateX(-0.8rem)" }}
                  side="left"
                  arrow
                >
                  刷新页面
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ),
        },
        {
          itemKey: "scroll-top",
          size: "sm",
          "aria-label": "回到顶部",
          title: "回到顶部",
          onClick: scrollToTop,
          children: (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Icon name="arrow_upward" size={19} />
                </TooltipTrigger>
                <TooltipContent
                  sx={{ transform: "translateX(-0.8rem)" }}
                  side="left"
                  arrow
                >
                  回到顶部
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ),
        },
      ]}
    >
      <Icon name="more_vert" size={20} />
    </GhostButtonGroup>
  );
}
