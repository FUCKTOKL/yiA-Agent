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

/** POST + SSE 流（对话与换绑二维码共用）：帧解析 event:/data:，done/error 收口 */
function ssePost(path, body, onsse) {
  return new Promise((resolve) => {
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
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
          const frames = buf.split(/\r?\n\r?\n/); buf = frames.pop() ?? "";
          for (const f of frames) {
            const ev = (f.match(/^event: (.+)$/m) ?? [])[1];
            const da = (f.match(/^data: (.+)$/m) ?? [])[1];
            if (ev) {
              let payload;
              try {
                payload = da ? JSON.parse(da) : {};
              } catch {
                onsse("error", { error: "回复数据不完整，请重新发送。" });
                return resolve(null);
              }
              if (!payload || typeof payload !== "object") {
                onsse("error", { error: "回复格式不正确，请重新发送。" });
                return resolve(null);
              }
              onsse(ev, payload);
              if (ev === "done" || ev === "error") return resolve(payload); // qr 等中间帧继续收
            }
          }
        }
        onsse("error", { error: "连接已中断，回复未完成，请重新发送。" });
        resolve(null);
      })
      .catch((e) => { onsse("error", { error: `连接出现问题：${e.message || String(e)}` }); resolve(null); });
  });
}

export const api = {
  status: () => req("GET", "/api/status"),
  context: () => req("GET", "/api/context"),
  memory: (q = "") => req("GET", `/api/memory?q=${encodeURIComponent(q)}`),
  refineMemory: (id, patch) => req("POST", `/api/memory/${id}`, patch),
  deleteMemory: (id) => req("DELETE", `/api/memory/${id}`),
  books: () => req("GET", "/api/books"),
  searchBooks: (query, bookId = "") => req("GET", `/api/books/search?q=${encodeURIComponent(query)}&bookId=${encodeURIComponent(bookId)}`),
  bookPassage: (id, passage) => req("GET", `/api/books/${encodeURIComponent(id)}/passages/${passage}`),
  bookOriginal: (id) => `/api/books/${encodeURIComponent(id)}/original`,
  bookContent: (id) => `/api/books/${encodeURIComponent(id)}/content`,
  bookReaderInfo: (id) => req("GET", `/api/books/${encodeURIComponent(id)}/reader-info`),
  bookView: (id, unit) => `/api/books/${encodeURIComponent(id)}/reader?unit=${unit}`,
  deleteBook: (id) => req("DELETE", `/api/books/${encodeURIComponent(id)}`),
  async importBook(file) {
    const res = await fetch(`/api/books/import?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
    const data = await res.json().catch(() => ({ error: `导入响应不完整（HTTP ${res.status}），请刷新书架确认结果。` }));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  },
  reminders: () => req("GET", "/api/reminders"),
  addReminder: (p) => req("POST", "/api/reminders", p),
  cancelReminder: (id) => req("DELETE", `/api/reminders/${id}`),
  wechat: () => req("GET", "/api/wechat"),
  wechatTest: () => req("POST", "/api/wechat/test"),
  wechatLogoutAll: () => req("POST", "/api/wechat/rebind/logout"),
  wechatPairing: () => req("GET", "/api/wechat/rebind/pairing"),
  wechatApprove: (code) => req("POST", "/api/wechat/rebind/approve", { code }),
  wechatSetTarget: (peer) => req("POST", "/api/wechat/rebind/target", { peer }),
  wechatRestart: () => req("POST", "/api/wechat/rebind/restart"),
  sessions: () => req("GET", "/api/sessions"),
  deleteSession: (id) => req("DELETE", `/api/sessions/${encodeURIComponent(id)}`),
  loginInfo: () => req("GET", "/api/login"),
  loginKey: (provider, key) => req("POST", "/api/login", { provider, key }),
  setModel: (model, provider) => req("POST", "/api/model", { model, provider }),
  chatHistory: (session = "web") => req("GET", `/api/chat/history?session=${encodeURIComponent(session)}`),

  /** SSE 对话：onsse(evt, data) 依次收到 start/done/error */
  chat(text, onsse, session = "web") {
    return ssePost("/api/chat", { text, session }, (event, data) => {
      if (event === "done" && (typeof data.text !== "string" || !data.text.trim())) {
        onsse("error", { error: "模型没有返回可显示的回复，请重试或更换模型。" });
      } else onsse(event, data);
    });
  },
  /** POST + SSE 流（换绑二维码流用） */
  sse(path, body, onsse) {
    return ssePost(path, body, onsse);
  },
};
