#!/usr/bin/env node
/**
 * yiA 天气 MCP 服务器（stdio）：零依赖、零 API key。
 * 数据源 Open-Meteo（免费无鉴权）：geocoding 定位 + forecast 天气。
 * 协议：MCP over stdio（JSON-RPC 2.0，一行一个 JSON 消息，Pi 原生 MCP 支持）。
 *
 * 工具：
 *   weather(location)  → 当前实况 + 今明后三天预报（中文）
 *   weather_by_coords(lat, lon) → 同上，跳过地理编码
 */
import { get as httpsGet } from "node:https";
// undici fetch 在本环境（Clash TUN）ETIMEDOUT 而 https.get 通——不纠结，直接用 https.get

const WMO = {
  0: "晴", 1: "大致晴", 2: "局部多云", 3: "阴", 45: "雾", 48: "雾凇",
  51: "毛毛雨", 53: "毛毛雨", 55: "毛毛雨", 56: "冻毛毛雨", 57: "冻毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "阵雨", 81: "阵雨", 82: "强阵雨", 85: "阵雪", 86: "阵雪",
  95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "雷阵雨伴冰雹",
};

async function jget(url) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`上游 ${res.statusCode}：${url.slice(0, 60)}`)); }
      let b = ""; res.setEncoding("utf8");
      res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("timeout", () => { req.destroy(new Error("上游超时")); });
    req.on("error", reject);
  });
}

async function geocode(name) {
  const d = await jget(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`);
  const hit = d.results?.[0];
  if (!hit) throw new Error(`找不到地点：${name}`);
  return { lat: hit.latitude, lon: hit.longitude, label: hit.name + (hit.admin1 ? `（${hit.admin1}）` : "") + (hit.country ? `，${hit.country}` : "") };
}

async function weatherText({ lat, lon, label }) {
  const d = await jget(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=auto&forecast_days=3`,
  );
  const c = d.current, day = d.daily;
  const lines = [
    `${label}（时区 ${d.timezone}）`,
    `现在：${WMO[c.weather_code] ?? "未知"} ${c.temperature_2m}°C（体感 ${c.apparent_temperature}°C），湿度 ${c.relative_humidity_2m}%，风 ${c.wind_speed_10m} km/h`,
  ];
  for (let i = 0; i < 3; i++) {
    lines.push(`${day.time[i]}：${WMO[day.weather_code[i]] ?? "?"} ${day.temperature_2m_min[i]}~${day.temperature_2m_max[i]}°C，降水概率 ${day.precipitation_probability_max?.[i] ?? 0}%`);
  }
  return lines.join("\n");
}

const TOOLS = [
  {
    name: "weather",
    description: "查询某地天气（当前实况 + 今明后三天预报）。location 支持城市名（中文/拼音/英文），如「北京」「Shanghai」。",
    inputSchema: { type: "object", properties: { location: { type: "string", description: "地点名" } }, required: ["location"] },
  },
  {
    name: "weather_by_coords",
    description: "按经纬度查天气（已知坐标时跳过地理编码更快）。",
    inputSchema: {
      type: "object",
      properties: { lat: { type: "number" }, lon: { type: "number" }, label: { type: "string", description: "地点名（可选，用于展示）" } },
      required: ["lat", "lon"],
    },
  },
];

const METHODS = {
  initialize: () => ({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "yia-weather", version: "1.0.0" } }),
  "tools/list": () => ({ tools: TOOLS }),
  async "tools/call"(params) {
    const tool = params.name;
    const args = params.arguments ?? {};
    let text;
    if (tool === "weather") {
      const g = await geocode(String(args.location));
      text = await weatherText(g);
    } else if (tool === "weather_by_coords") {
      text = await weatherText({ lat: args.lat, lon: args.lon, label: args.label || `${args.lat},${args.lon}` });
    } else {
      throw new Error(`未知工具：${tool}`);
    }
    return { content: [{ type: "text", text }] };
  },
};

// stdio JSON-RPC：一行一个请求对象，响应也按行写回
let buf = "", pending = 0, inputEnded = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    pending++;
    handle(req).catch((e) => {
      write({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32603, message: String(e).slice(0, 300) } });
    }).finally(() => {
      pending--;
      if (inputEnded && pending === 0) process.exit(0);
    });
  }
});
async function handle(req) {
  const fn = METHODS[req.method];
  if (!fn) return write({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32601, message: `method not found: ${req.method}` } });
  const result = await fn(req.params ?? {});
  if (req.id !== undefined && req.id !== null) write({ jsonrpc: "2.0", id: req.id, result });
}
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
process.stdin.on("end", () => {
  inputEnded = true;
  if (pending === 0) process.exit(0);
});
