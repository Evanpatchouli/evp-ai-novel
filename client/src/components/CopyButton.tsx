import { Button } from "@ldkj/web-ui";
import type { ShowNotice } from "../app/types";

export function CopyButton({
  text,
  notify,
  compact = false,
}: {
  text: string;
  notify: ShowNotice;
  compact?: boolean;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      notify({ tone: "success", message: "已复制到剪贴板。" });
    } catch {
      notify({ tone: "error", message: "浏览器拒绝访问剪贴板，请手动复制。" });
    }
  };
  return (
    <Button
      size="sm"
      variant={compact ? "ghost" : "outline"}
      sx={{ color: compact ? "gray" : undefined }}
      onClick={() => void copy()}
    >
      {compact ? "复制" : "复制内容"}
    </Button>
  );
}
