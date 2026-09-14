/**
 * 渠道注册表（PRD F4.2 / F6 预留位）：按渠道 id 路由发送，统一降级策略。
 *
 * - 微信发送失败（Gateway 不在线/未配置）→ 自动降级到 TUI 通知（PRD §8 风险表）
 * - 新渠道（飞书/QQ）注册进来即可，调用方无感
 */
import type { Logger } from "../logger.ts";

export interface ChannelSender {
  /** 发送文本；失败抛异常（由 registry 统一降级） */
  send(to: string, text: string): Promise<void>;
  /** 渠道是否可用（配置存在且探测通过） */
  available(): Promise<boolean>;
}

export class ChannelRegistry {
  private readonly logger: Logger;
  private channels = new Map<string, ChannelSender>();
  /** 降级链：wechat → tui（可扩展） */
  private fallback: Record<string, string> = { wechat: "tui" };

  constructor(logger: Logger) {
    this.logger = logger;
  }

  register(id: string, sender: ChannelSender): void {
    this.channels.set(id, sender);
  }

  /**
   * 发送消息。失败时沿降级链兜底，绝不静默丢失。
   * 返回实际使用的渠道 id。
   */
  async send(channelId: string, to: string, text: string): Promise<string> {
    let current = channelId;
    for (let hop = 0; hop < 3; hop++) {
      const sender = this.channels.get(current);
      if (!sender) break;
      try {
        if (!(await sender.available())) throw new Error(`渠道 ${current} 不可用`);
        await sender.send(to, text);
        return current;
      } catch (e) {
        this.logger.warn(`渠道 ${current} 发送失败，尝试降级`, { error: String(e), to });
        const next = this.fallback[current];
        if (!next) throw e;
        current = next;
      }
    }
    throw new Error(`消息发送失败：渠道 ${channelId} 及其降级链均不可用`);
  }
}
