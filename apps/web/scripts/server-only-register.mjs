import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// 仅限 Node 脚本宿主预加载；不改变 React 条件或 Next 的客户端污染检测。
const require = createRequire(import.meta.url);
const marker = pathToFileURL(require.resolve("next/dist/compiled/server-only/empty")).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: marker, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
