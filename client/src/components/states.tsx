import { Alert, Button, Empty } from "@ldkj/web-ui";
import emptyImage from "../assets/empty.svg";

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Alert
      variant="error"
      showIcon
      title="无法完成操作"
      description={message}
      action={
        onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            重试
          </Button>
        ) : undefined
      }
    />
  );
}

export function LoadingState({
  label = "正在读取本地数据",
}: {
  label?: string;
}) {
  return (
    <div className="loading" role="status">
      <span className="loading-mark" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  label,
  detail,
}: {
  label: string;
  detail?: string;
}) {
  return (
    <Empty
      image={<img src={emptyImage} alt="" aria-hidden="true" />}
      description={
        <div>
          <strong>{label}</strong>
          {detail && <p>{detail}</p>}
        </div>
      }
    />
  );
}
