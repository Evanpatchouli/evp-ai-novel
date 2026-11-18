import type { ComponentProps, PropsWithChildren } from "react";
import { Button } from "@ldkj/web-ui";

type AsyncButtonProps = Omit<ComponentProps<typeof Button>, "loading"> & {
  busy?: boolean;
};

/** 使用标准禁用与 aria 状态表达忙碌。 */
export function AsyncButton({ busy = false, children, ...props }: PropsWithChildren<AsyncButtonProps>) {
  return (
    <Button {...props} aria-busy={busy || undefined} loading={busy}>
      {children}
    </Button>
  );
}
