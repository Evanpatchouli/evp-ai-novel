export type NoticeAction =
  | {
      kind: "link";
      label: string;
      href: string;
      download?: boolean;
    }
  | {
      kind: "button";
      label: string;
      onClick: () => void;
    };

export type Notice = {
  tone: "success" | "error" | "info";
  message: string;
  actions?: NoticeAction[];
} | null;

export type ShowNotice = (notice: NonNullable<Notice>) => void;
