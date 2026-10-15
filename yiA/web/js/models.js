/** 模型设置：只操作 yiA 独立运行时，不读取或展示密钥。 */
import { $, api } from "./api.js";
import { openDialog } from "./dialogs.js";

const providerNames = {
  "openai": "OpenAI", "openai-codex": "OpenAI Codex",
  "anthropic": "Anthropic", "google": "Google",
  "zai-coding-cn": "智谱 GLM · Coding Plan", "zai": "智谱 GLM",
};
const providerName = (id) => Object.hasOwn(providerNames, id) ? providerNames[id] : id;
const providerSelect = $("#modelProvider"), modelSelect = $("#modelChoice"), save = $("#modelSaveBtn");
let info = null, loading = false, saving = false, request = 0;

function feedback(text = "", error = false) {
  const el = $("#modelFeedback");
  el.textContent = text;
  el.classList.toggle("is-error", error);
}

function selectedModel() {
  return info?.models.find((m) => m.provider === providerSelect.value && m.id === modelSelect.value);
}

function updateSelection() {
  const selected = selectedModel();
  $("#modelSelection").textContent = selected ? `${selected.provider} / ${selected.id}` : "";
  save.disabled = loading || saving || !selected ||
    (selected.provider === info.defaultProvider && selected.id === info.defaultModel);
}

function fillModels(preferred = "") {
  const choices = info.models.filter((m) => m.provider === providerSelect.value);
  modelSelect.replaceChildren(...(choices.length ? choices.map((m) => new Option(m.name, m.id)) : [new Option("暂无可选模型", "")]));
  if (choices.some((m) => m.id === preferred)) modelSelect.value = preferred;
  modelSelect.disabled = !choices.length || saving;
  updateSelection();
}

function displayCurrent() {
  const current = info.models.find((m) => m.provider === info.defaultProvider && m.id === info.defaultModel);
  const name = current?.name || info.defaultModel || "尚未选择";
  $("#modelCurrent").textContent = name;
  $("#modelCurrentProvider").textContent = info.defaultProvider ? providerName(info.defaultProvider) : "尚未接入服务商";
  $("#currentModelName").textContent = name;
  $("#modelSettingsBtn").title = `模型设置 · ${name}`;
}

async function load() {
  const token = ++request;
  loading = true;
  providerSelect.disabled = modelSelect.disabled = save.disabled = true;
  feedback("正在读取已接入的模型…");
  try {
    const result = await api.loginInfo();
    if (token !== request) return;
    info = result;
    displayCurrent();
    const providers = [...new Set(info.models.map((m) => m.provider))];
    providerSelect.replaceChildren(...(providers.length ? providers.map((p) => new Option(providerName(p), p)) : [new Option("暂无已接入服务商", "")]));
    providerSelect.value = providers.includes(info.defaultProvider) ? info.defaultProvider : (providers[0] || "");
    providerSelect.disabled = !providers.length;
    loading = false;
    fillModels(info.defaultModel);
    feedback(providers.length ? "切换后从下一条消息生效。列表中的型号是否可用，以您的账号权限为准。" : "还没有可选模型。请在 yiA 终端运行 /login 接入服务商，再点「重新读取」。");
  } catch (e) {
    if (token !== request) return;
    loading = false;
    $("#currentModelName").textContent = "模型暂不可用";
    feedback(`读取失败：${e.message}。您可以重新读取。`, true);
  }
}

export async function openModelSettings() {
  if (saving) return;
  openDialog("modelOv");
  await load();
}

export function initModelSettings() {
  $("#modelSettingsBtn").onclick = openModelSettings;
  $("#modelReloadBtn").onclick = () => { if (!saving) return load(); };
  providerSelect.onchange = () => { feedback(); fillModels(); };
  modelSelect.onchange = () => { feedback(); updateSelection(); };
  $("#modelForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = selectedModel();
    if (!selected || loading || saving || save.disabled) return;
    saving = true;
    providerSelect.disabled = modelSelect.disabled = save.disabled = true;
    save.textContent = "保存中…";
    feedback("正在切换模型，聊天记录会保留…");
    try {
      const result = await api.setModel(selected.id, selected.provider);
      info.defaultProvider = result.provider;
      info.defaultModel = result.model;
      displayCurrent();
      feedback(result.note);
    } catch (e) {
      feedback(`未能保存：${e.message}`, true);
    } finally {
      saving = false;
      providerSelect.disabled = modelSelect.disabled = false;
      save.textContent = "保存设置";
      updateSelection();
    }
  });
  void load();
}
