import { refreshOriginalCoreConfiguration } from "../mcp/core/original-core-config-store.js";
import { defaultDataDirectory } from "../mcp/core/runtime-paths.js";
try {
  console.log(
    JSON.stringify(
      await refreshOriginalCoreConfiguration({
        dataDirectory: defaultDataDirectory(),
      }),
    ),
  );
} catch {
  console.error("原版配置更新失败；未自动重试，未输出授权内容。");
  process.exitCode = 1;
}
