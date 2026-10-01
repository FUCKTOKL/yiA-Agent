# yia-ui — M6 Web 原型

yiA 的 Web 前端原型（M6 阶段）。纯静态、零依赖、零构建，已模块化：ES 模块 + 按页拆分 HTML。数据为 `js/data.js` 内置演示数据，后续接 HTTP+SSE（见 PRD P2）。

## 打开方式

ES 模块不能从 file:// 直开（浏览器 CORS 拦截，页面会给出提示），需本地服务器：

```sh
cd yia-ui && python3 -m http.server 8123
# 访问 http://localhost:8123/          （对话页）
#      http://localhost:8123/#memory   （记忆图谱，其余 #reminders #wechat）
```

注意：背景持久化存在浏览器 localStorage，按源隔离——请固定用同一地址进入（如始终 localhost:8123），不要混用 127.0.0.1 / 局域网 IP / 其他端口，否则各是各的存储。更新代码后如样式未变，Ctrl+Shift-R 强刷一次（index.html 已用 ?v= 版本参数引用静态资源，大改后递增版本号即可）。

## 结构

```text
yia-ui/
├── index.html            壳：环境背景 / 导航轨 / 舞台容器 / file:// 兜底提示
├── pages/                页面碎片（含各自的弹层），路由按需 fetch + 挂载
│   ├── chat.html         对话（双岛）+ 引用浮卡 + 命令面板
│   ├── memory.html       记忆图谱（双岛）+ 聚焦阅读层 + 删除确认
│   ├── reminders.html    提醒 + 新建弹层
│   └── wechat.html       微信通道 + 换绑确认
├── css/                  令牌（tokens）/ 基础（base）/ 按页样式
└── js/
    ├── app.js            入口：hash 路由 / 主题 / 背景 / 状态浮层 / 弹层委托
    ├── data.js           模型层：演示数据 + 共享状态（原地增删，跨模块同源）
    ├── lib/dom.js        $ / $$ / esc / setHtml / setSvg（DOMParser 受控注入）
    └── pages/*.js        按页视图模块，export mount()，动态 import 按需挂载
```

路由：导航点击或改 hash → fetch `pages/<name>.html` 碎片 → 动态 `import('./pages/<name>.js')` 调 `mount()`（每页仅一次）。页面间共享数据只经 `data.js`，无全局变量。

## 定位与设计读感

个人助理产品面板（对话 / 记忆图谱 / 提醒 / 微信通道），非营销页。视觉语言为「轻烟玻璃浮于暖调书房」：暗色默认（首访跟随系统偏好）、亮色可切。玻璃配方（base.css）：blur(16px) 让背景形状透出 + brightness(.9) 压亮区 + 低 tint 暗底（见 tokens）+ 白描边 + 内高光；可见透明是目标，不是附带效果。

## 已过一轮设计审查（2026-09-29）

修复记录：重复 id fbToggle、全量 focus-visible 键盘焦点、:active 按压触感、暗色玻璃白雾改烟熏底、t2/t3 对比度提亮、颜色全部令牌化（accent/ok 系禁裸写 hex）、hover 去纯黑、跟随 prefers-color-scheme、prefers-reduced-transparency 实底降级、seg/fb-toggle 改原生 button + aria-pressed、meta 行中圆点每行至多一个、引用浮卡视口钳制。模块化改造时全部渲染改走 setHtml/setSvg（DOMParser 注入，无 innerHTML 形态），数据侧统一 esc()。

## 约定

- 颜色一律走 `css/tokens.css` 令牌；新色先加令牌再用。
- 列表/图谱渲染一律 `setHtml` / `setSvg`；动态字符串先 `esc()`。
- 圆角体系：容器 24-32px、按钮/输入 pill、内嵌块 14-20px，不混用锐角。
- 交互元素用原生 button；图标按钮带 title + aria-label。
- 主题二选一锁整页（body.light），无局部反转。

## 已知天花板（有意为之，接后端时再升）

- 桌面优先：目标视口 ≥1100px，无响应式断言，窄屏不保证。MVP 期定位个人电脑自用。
- 文字对比度分两种情况：默认渐变背景下 t2 ≥5:1、t3 ≈4.2:1（AA 线 4.5）；自定义亮背景的高光区不保证 AA（可见透明的固有代价），介意可把背景图调暗或升用 t2。
- 自定义背景持久化：上传图经 canvas 降采样到 1920 宽 JPEG（数百 KB）存 localStorage，下次进入自动恢复；成功弹「背景已固定」提示，超配额则提示后仅当次生效。若换地址（127.0.0.1/其他端口）进入则各自独立存储。
- `.error-card` 样式已备，等接真实后端错误路径启用。

## 验证

无头渲染 + DOM 断言即可（无测试框架）：

```sh
cd yia-ui && python3 -m http.server 8123 &
chrome-headless-shell --headless --disable-gpu --no-sandbox --virtual-time-budget=4000 \
  --dump-dom http://localhost:8123/#memory | grep -c "file-row\|class=\"node"
```

四条路由各验一次（chat / #memory / #reminders / #wechat），配合 stderr 日志查 JS 报错。
