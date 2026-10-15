/** Pi 的模型错误可能写在 assistant.errorMessage 中，而不是由 prompt() 抛出。 */
interface ReplyMessage {
  role: string;
  content?: unknown;
  errorMessage?: unknown;
  stopReason?: unknown;
}

export const EMPTY_REPLY_MESSAGE = "模型没有返回可显示的回复，请重试，或在右上角的模型设置中更换模型。";

export function formatReplyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const unsupported = raw.match(/The '([\w.\/-]+)' model is not supported when using Codex with a ChatGPT account/i);
  if (unsupported) {
    return `您当前的 ChatGPT 账号不支持模型 ${unsupported[1]}。请在右上角的模型设置中，选择该账号支持的型号；若要使用这个型号，需要改用支持它的接入方式。`;
  }
  // 上游错误可能带请求信息，先去掉常见凭据，再限制展示长度。
  return (raw
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [已隐藏]")
    .replace(/\bsk-[\w-]+/g, "[已隐藏]")
    .replace(/(\b(?:api[-_]?key|access(?:[-_]?token)?|refresh(?:[-_]?token)?|token|key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[已隐藏]")
    .trim() || EMPTY_REPLY_MESSAGE).slice(0, 500);
}

/** 只接受本轮最后一条 assistant 的文字；不把失败、空回复或上一轮答案当作成功。 */
export function getAssistantReply(messages: readonly ReplyMessage[]): string {
  let assistant: ReplyMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") break;
    if (messages[i].role === "assistant") { assistant = messages[i]; break; }
  }
  if (!assistant) throw new Error(EMPTY_REPLY_MESSAGE);
  if (assistant.errorMessage || assistant.stopReason === "error") {
    throw new Error(formatReplyError(assistant.errorMessage));
  }
  if (assistant.stopReason === "aborted") throw new Error("这次回复已中断，请重新发送。");
  const text = (Array.isArray(assistant.content) ? assistant.content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  if (!text.trim()) throw new Error(EMPTY_REPLY_MESSAGE);
  return text;
}
