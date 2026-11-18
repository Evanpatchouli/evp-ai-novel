import { createApp } from "./app.js";
import { checkGitRuntime } from "./git-runtime.js";

async function start() {
  const gitVersion = await checkGitRuntime();
  const port = Number(process.env.PORT ?? 6174);
  const app = createApp();
  app.on("error", (error) => console.error("创作工作台服务错误", error));
  app.listen(port, "127.0.0.1", () => {
    console.log(
      `evp-ai-novel 创作工作台已启动：http://127.0.0.1:${port}（${gitVersion}）`,
    );
  });
}

start().catch((error: unknown) => {
  console.error(
    "创作工作台启动失败。",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
