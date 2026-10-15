import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export interface ModelChoice {
  provider: string;
  id: string;
  name: string;
}

/** 使用与无头会话相同的模型目录，只列已接入服务商；不向模型发送请求。 */
export async function loadModelCatalog(agentDir: string): Promise<ModelChoice[]> {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  return runtime.getModels()
    .filter((m) => runtime.hasConfiguredAuth(m.provider))
    .map((m) => ({ provider: m.provider, id: m.id, name: m.name || m.id }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}
