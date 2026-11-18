import { Alert, Button } from "@ldkj/web-ui";
import type { Notice } from "../app/types";

/** 展示全局通知，并在需要时提供可持续操作的链接或按钮。 */
export function NoticeBanner({
  notice,
  onClose,
}: {
  notice: NonNullable<Notice>;
  onClose: () => void;
}) {
  const actions = notice.actions?.length ? (
    <div className="notice-actions">
      {notice.actions.map((action) =>
        action.kind === "link" ? (
          <Button
            key={`${action.kind}-${action.label}`}
            component="a"
            size="sm"
            variant="primary"
            href={action.href}
            download={action.download}
          >
            {action.label}
          </Button>
        ) : (
          <Button
            key={`${action.kind}-${action.label}`}
            size="sm"
            variant="outline"
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ),
      )}
    </div>
  ) : undefined;

  return (
    <Alert
      variant={
        notice.tone === "error"
          ? "error"
          : notice.tone === "success"
            ? "success"
            : "info"
      }
      showIcon
      description={notice.message}
      action={actions}
      closable
      onClose={onClose}
    />
  );
}
