import { Button, Form, Input } from "@ldkj/web-ui";

export interface VolumeFormValues {
  title: string;
}

interface VolumeFormProps {
  mode: "create" | "edit";
  volumeId: string;
  volumeNumber: number;
  targetPath: string;
  values: VolumeFormValues;
  busy?: boolean;
  onChange(values: VolumeFormValues): void;
  onSubmit(): void;
}

/** 卷创建与资料修改共用的结构化表单。 */
export function VolumeForm({
  volumeId,
  volumeNumber,
  targetPath,
  values,
  busy = false,
  onChange,
  onSubmit,
}: VolumeFormProps) {
  const titleValid =
    values.title.trim().length > 0 && values.title.length <= 120;
  return (
    <Form
      className="volume-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (titleValid && !busy) onSubmit();
      }}
    >
      <div className="volume-identity-grid" aria-label="不可变卷身份">
        <div>
          <span>卷 ID</span>
          <strong>{volumeId}</strong>
          <small>创建后不可修改</small>
        </div>
        <div>
          <span>卷号</span>
          <strong>第 {volumeNumber} 卷</strong>
          <small>用于全书排序</small>
        </div>
      </div>

      <Form.Item
        label="卷名"
        required
        help={
          values.title.length > 120
            ? "卷名不能超过 120 个字符。"
            : "卷名只保存在状态 YAML 中，不参与目录路径。"
        }
        validateStatus={values.title.length > 120 ? "error" : undefined}
      >
        <Input
          aria-label="卷名"
          autoFocus
          value={values.title}
          maxLength={121}
          disabled={busy}
          onChange={(event) =>
            onChange({ ...values, title: event.target.value })
          }
          placeholder="输入卷名"
        />
      </Form.Item>

      <dl className="volume-form-path">
        <div>
          <dt>状态文件</dt>
          <dd>{targetPath}</dd>
        </div>
      </dl>

      <div className="volume-form-actions">
        <Button type="submit" variant="primary" disabled={!titleValid || busy}>
          {busy ? "正在生成预览…" : "预览变更"}
        </Button>
      </div>
    </Form>
  );
}
