/**
 * 微信渠道配置（runtime/config/wechat.json）。
 *
 * 密钥纪律（PRD §5）：gatewayToken 等凭据只存在于 runtime/（gitignored），
 * 不入库、不进会话记录、不进日志。
 */
import { existsSync, readFileSync } from "node:fs";

export interface WechatConfig {
  enabled: boolean;
  /** OpenClaw Gateway 地址（Windows 侧，provision 脚本探测写入） */
  gatewayUrl: string;
  /** Gateway 操作者 token（OPENCLAW_GATEWAY_TOKEN） */
  gatewayToken: string;
  /** 微信渠道 id（插件固定 openclaw-weixin） */
  channel: string;
  /** 发送账号 id（bot 的 accountId，多账号时必须指定，否则发错号） */
  account?: string;
  /** 默认回推目标：用户自己的微信 id（xxx@im.wechat） */
  targetPeer: string;
}

export const WECHAT_CONFIG_PATH = "runtime/config/wechat.json";

/** 读配置；不存在/损坏返回 null（渠道禁用，调用方降级 TUI） */
export function loadWechatConfig(projectRoot: string): WechatConfig | null {
  const file = `${projectRoot}/${WECHAT_CONFIG_PATH}`;
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw.gatewayUrl || !raw.targetPeer) return null;
    return {
      enabled: raw.enabled !== false,
      gatewayUrl: String(raw.gatewayUrl),
      gatewayToken: String(raw.gatewayToken ?? ""),
      channel: String(raw.channel ?? "openclaw-weixin"),
      account: raw.account ? String(raw.account) : undefined,
      targetPeer: String(raw.targetPeer),
    };
  } catch {
    return null;
  }
}
