/** API 客户端：全部后端交互集中于此（其余模块只调这里，不散落 fetch） */
export const $ = (s) => document.querySelector(s);
export const $$ = (s) => [...document.querySelectorAll(s)];
export const esc = (s) => String(s).replace(/</g, "&lt;");

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `非 JSON 响应（HTTP ${res.status}）` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  status: () => req("GET", "/api/status"),
  context: () => req("GET", "/api/context"),
  memory: (q = "") => req("GET", `/api/memory?q=${encodeURIComponent(q)}`),
  refineMemory: (id, patch) => req("POST", `/api/memory/${id}`, patch),
  deleteMemory: (id) => req("DELETE", `/api/memory/${id}`),
  reminders: () => req("GET", "/api/reminders"),
  addReminder: (p) => req("POST", "/api/reminders", p),
  cancelReminder: (id) => req("DELETE", `/api/reminders/${id}`),
  wechat: () => req("GET", "/api/wechat"),
  wechatTest: () => req("POST", "/api/wechat/test"),
  chatHistory: () => req("GET", "/api/chat/history"),

  /** SSE 对话：onsse(evt, data) 依次收到 start/done/error */
  chat(text, onsse) {
    return new Promise((resolve) => {
      fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
        .then(async (res) => {
          if (!res.ok || !res.body) {
            const e = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            onsse("error", e); return resolve(null);
          }
          const rd = res.body.getReader(), dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await rd.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            // 解析 SSE 帧：空行分隔，event:/data: 两行
            const frames = buf.split("\n\n"); buf = frames.pop() ?? "";
            for (const f of frames) {
              const ev = (f.match(/^event: (.+)$/m) ?? [])[1];
              const da = (f.match(/^data: (.+)$/m) ?? [])[1];
              if (ev) { const payload = da ? JSON.parse(da) : {}; onsse(ev, payload); if (ev !== "start") return resolve(payload); }
            }
          }
          resolve(null);
        })
        .catch((e) => { onsse("error", { error: String(e) }); resolve(null); });
    });
  },
};
