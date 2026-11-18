import { forwardRef, type ComponentPropsWithoutRef } from "react";

export type TextareaProps = ComponentPropsWithoutRef<"textarea">;

/** 使用组件库主题令牌的共享多行文本输入。 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = "", ...props }, ref) => (
    <textarea
      ref={ref}
      className={`workbench-textarea${className ? ` ${className}` : ""}`}
      {...props}
    />
  ),
);

Textarea.displayName = "Textarea";
