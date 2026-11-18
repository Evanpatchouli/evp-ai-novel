import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectItems,
  SelectTrigger,
  SelectValue,
  type SelectOption,
} from "@ldkj/web-ui";
import { isAppearanceMode, useAppearance } from "./appearance";

const APPEARANCE_OPTIONS: SelectOption[] = [
  { label: "宣纸白", value: "plain" },
  { label: "深墨黑", value: "modern" },
  { label: "晴空蓝", value: "sky" },
];

/** 顶部栏三态外观选择器，切换后同步业务与组件库主题。 */
export function AppearanceSelect() {
  const labelId = useId();
  const { appearance, setAppearance } = useAppearance();

  return (
    <div className="appearance-select">
      <span id={labelId} className="appearance-select-copy">
        界面风格
      </span>
      <Select
        value={appearance}
        onValueChange={(value: string) => {
          if (isAppearanceMode(value)) setAppearance(value);
        }}
      >
        <SelectTrigger
          aria-labelledby={labelId}
          className="appearance-select-trigger"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" sideOffset={6}>
          <SelectItems options={APPEARANCE_OPTIONS} />
        </SelectContent>
      </Select>
    </div>
  );
}
