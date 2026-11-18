import { useEffect, useState } from "react";
import { Alert, Chip } from "@ldkj/web-ui";
import type { AutomationCapabilities } from "../../../../shared/contracts";
import { api } from "../../api";
import { useRepositorySession } from "../../app/RepositorySession";
import browserIllustration from "../../assets/broswer.svg";
import readDataIllustration from "../../assets/read-data.svg";
import uploadIllustration from "../../assets/upload.svg";
import { PageHeader, Panel } from "../../components/layout";
import { ErrorState, LoadingState } from "../../components/states";

export function AutomationPage() {
  const { dashboard } = useRepositorySession();
  const [data, setData] = useState<AutomationCapabilities | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setData(null);
    setError("");
    void api
      .automation()
      .then(setData)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "读取失败"),
      );
  }, [dashboard?.repositoryRoot]);

  return (
    <>
      <PageHeader
        eyebrow="未来能力接口"
        title="浏览器自动化保持显式、可关闭"
        description="当前创作流程仍以手工使用 ChatGPT Web 为准；Playwright 接口只报告能力，不读取登录凭据。"
      />
      <Panel>
        {error ? (
          <ErrorState message={error} />
        ) : !data ? (
          <LoadingState label="正在检查自动化能力" />
        ) : (
          <div className="capability-grid">
            <div className="capability-lead">
              <Chip variant={data.enabled ? "success" : "default"}>
                {data.enabled ? "已启用" : "未启用"}
              </Chip>
              <h2>
                {data.provider === "playwright"
                  ? "Playwright 浏览器接口"
                  : "浏览器自动化已关闭"}
              </h2>
              <p>{data.reason}</p>
            </div>
            <Capability
              label="打开浏览器"
              illustration={browserIllustration}
              enabled={data.canOpenBrowser}
            />
            <Capability
              label="上传任务包"
              illustration={uploadIllustration}
              enabled={data.canUploadFiles}
            />
            <Capability
              label="读取页面输出"
              illustration={readDataIllustration}
              enabled={data.canReadOutput}
            />
          </div>
        )}
      </Panel>
      <Alert
        className="automation-boundary-alert"
        variant="info"
        showIcon
        title="安全边界"
        style={{
          marginTop: "1rem",
        }}
      >
        <span className="automation-boundary-alert-description">
          未来启用自动化也应由作者主动触发；不保存 ChatGPT
          凭据，不读取浏览器 Cookie，不自动上传未选择的仓库文件。
        </span>
      </Alert>
    </>
  );
}

function Capability({
  label,
  illustration,
  enabled,
}: {
  label: string;
  illustration: string;
  enabled: boolean;
}) {
  return (
    <div className="capability" data-enabled={enabled}>
      <span>{label}</span>
      <img
        className="capability-illustration"
        src={illustration}
        alt={`${label}能力示意图`}
      />
      <strong>{enabled ? "可用" : "不可用"}</strong>
    </div>
  );
}
