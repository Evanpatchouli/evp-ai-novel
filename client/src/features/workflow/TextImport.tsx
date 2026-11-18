export function TextImport({
  value,
  onChange,
  label,
  tall = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  tall?: boolean;
}) {
  const readFile = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result ?? ""));
    reader.readAsText(file, "utf-8");
  };
  return (
    <div className="text-import">
      <label>
        <span>{label}</span>
        <textarea
          className={tall ? "tall" : ""}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={`在这里粘贴${label}…`}
        />
      </label>
      <label className="file-picker">
        从 .md / .txt 文件读取
        <input
          type="file"
          accept=".md,.txt,text/plain,text/markdown"
          onChange={(event) => readFile(event.target.files?.[0])}
        />
      </label>
    </div>
  );
}
