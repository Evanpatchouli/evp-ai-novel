import type { AutomationCapabilities } from "../shared/contracts.js";

/** 未来浏览器自动化的最小边界；实现不得读取 Cookie 或保存登录凭据。 */
export interface BrowserAutomationProvider {
  capabilities(): AutomationCapabilities;
  openChat?(url?: string): Promise<void>;
  uploadContextPackage?(file: string): Promise<void>;
  readAssistantOutput?(): Promise<string>;
}

export class DisabledBrowserAutomationProvider implements BrowserAutomationProvider {
  capabilities(): AutomationCapabilities {
    return {
      provider: "disabled",
      enabled: false,
      canOpenBrowser: false,
      canUploadFiles: false,
      canReadOutput: false,
      reason:
        "MVP 默认禁用浏览器自动化；已保留 Playwright Provider 接口供未来显式接入。",
    };
  }
}

export const browserAutomation: BrowserAutomationProvider =
  new DisabledBrowserAutomationProvider();
