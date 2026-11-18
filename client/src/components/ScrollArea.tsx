import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
} from "react";

export interface ScrollAreaProps extends ComponentPropsWithoutRef<"div"> {
  /** 滚动区域的最大高度；数字按像素处理。 */
  maxHeight: CSSProperties["maxHeight"];
}

/**
 * 带键盘焦点、稳定滚动条槽和滚动边界约束的纵向滚动容器。
 * 作为 region 使用时应传入 aria-label 或 aria-labelledby。
 */
export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  (
    {
      maxHeight,
      className = "",
      role = "region",
      tabIndex = 0,
      style,
      ...props
    },
    ref,
  ) => (
    <div
      {...props}
      ref={ref}
      role={role}
      tabIndex={tabIndex}
      className={`scroll-area${className ? ` ${className}` : ""}`}
      style={{ ...style, maxHeight }}
    />
  ),
);

ScrollArea.displayName = "ScrollArea";
