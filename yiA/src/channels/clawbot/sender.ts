/**
 * ClawBot（OpenClaw Gateway）微信发送适配器（PRD F4.2/F4.3）。
 *
 * 发送路径：POST {gatewayUrl}/tools/invoke 调 Gateway 的 message 工具
 * （weixin 插件注册了完整 outbound sendText，目标格式 <id>@im.wechat）。
 * 认证：Authorization: Bearer <gatewayToken>（操作者共享密钥）。
 *
 * ponytail: 当前每次消息一个 HTTP 请求；后续量大可换 WS 长连接复用。
 */
import type { ChannelSender } from "../registry.ts";
import type { Logger } from "../logger.ts";
import type { WechatConfig } from "../wechat-config.ts";

export class ClawbotSender implements ChannelSender {
  private readonly config: WechatConfig;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: WechatConfig,
    logger: Logger,
    fetchImpl: typeof fetch = fetch, // 测试可注入
  ) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
  }

  async available(): Promise<boolean> {
    return this.config.enabled && !!this.config.gatewayToken;
  }

  async send(to: string, text: string): Promise<void> {
    const res = await this.fetchImpl(`${this.config.gatewayUrl}/tools/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.gatewayToken}`,
      },
      body: JSON.stringify({
        tool: "message",
        // tools/invoke 请求体：工具参数放 args（不是 params），否则工具读到空参数报 action required
        args: {
          action: "send",
          channel: this.config.channel,
          // 多账号时必须指定 accountId，否则插件会从错误的 bot 账号发出（插件源码明确要求）
          ...(this.config.account ? { accountId: this.config.account } : {}),
          target: to || this.config.targetPeer,
          message: text,
        },
      }),
      // 微信发送是短任务，30s 足够；超时视为失败走降级
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Gateway ${res.status}: ${body.slice(0, 200)}`);
    }
    // Gateway 可能 200 但业务失败（如未配对），看返回体
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (data.ok === false) throw new Error(`Gateway 拒绝: ${data.error ?? "unknown"}`);
    this.logger.info("微信消息已发送", { to });
  }
}
