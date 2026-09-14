/** 入口：装配全局壳与四页模块（各模块自带数据加载与错误兜底） */
import { initShell } from "./app.js";
import { initChat } from "./chat.js";
import { initMemory } from "./memory.js";
import { initReminders } from "./reminders.js";
import { initWechat } from "./wechat.js";
import { refreshStatus } from "./status.js";

initShell();
initChat();
initMemory();
initReminders();
initWechat();
refreshStatus();
