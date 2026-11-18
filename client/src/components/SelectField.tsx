import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectItems,
  type SelectOption,
  SelectTrigger,
  SelectValue,
} from "@ldkj/web-ui";

export interface SelectFieldProps {
  label: string;
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}

/** 统一工作台内组件库 Select 的标签、触发器和弹层结构。 */
export function SelectField({
  label,
  value,
  options,
  onValueChange,
  className = "",
  disabled = false,
  placeholder = "请选择",
}: SelectFieldProps) {
  const labelId = useId();

  return (
    <div className={`select-field ${className}`}>
      <span id={labelId} className="select-field-label">
        {label}
      </span>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger aria-labelledby={labelId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent position="popper" sideOffset={4}>
          <SelectItems options={options} />
        </SelectContent>
      </Select>
    </div>
  );
}
