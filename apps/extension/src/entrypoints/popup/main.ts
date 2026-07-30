import { browser } from "wxt/browser";
import { createPageEpoch } from "@bpa/browser-bridge";
import {
  ASSISTANCE_SUMMARY_LABELS,
  ASSISTANCE_SUPERVISION_LABELS,
  AssistancePanelRepository
} from "../../lib/assistance-panel";

const labels: Record<string, string> = {
  host: "Native Host",
  core: "Local Core",
  protocol: "协议",
  sessionId: "会话",
  currentTask: "当前任务",
  permissions: "权限",
  updatedAt: "更新时间"
};

const panel = new AssistancePanelRepository({
  get: (key) => browser.storage.local.get(key),
  set: (value) => browser.storage.local.set(value)
});

const DESIGN_MODE_ORIGINS = new Set([
  "https://fxg.jinritemai.com",
  "https://www.chanmama.com"
]);

async function prepareDesignModeBinding(): Promise<void> {
  const message = document.querySelector("#design-mode-message")!;
  const output = document.querySelector(
    "#design-mode-binding"
  ) as HTMLTextAreaElement;
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true
  });
  if (tab?.id == null || !tab.url) {
    message.textContent = "没有可授权的活动页面。";
    return;
  }
  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    message.textContent = "当前页面地址无效。";
    return;
  }
  if (
    !DESIGN_MODE_ORIGINS.has(url.origin) ||
    /login|passport|signin|authorize/iu.test(url.pathname)
  ) {
    message.textContent = "当前页面不在 Design Mode 只读允许范围内。";
    return;
  }
  const binding = JSON.stringify({
    version: "bpa.design-page-binding/1",
    tabId: tab.id,
    origin: url.origin,
    pageEpoch: createPageEpoch(tab.id),
    issuedAt: new Date().toISOString()
  });
  output.value = binding;
  output.hidden = false;
  output.focus();
  output.select();
  try {
    await navigator.clipboard.writeText(binding);
    message.textContent = "页面绑定码已复制；它只用于本次 15 分钟授权。";
  } catch {
    message.textContent = "页面绑定码已生成，请手动复制。";
  }
}

async function render(): Promise<void> {
  const value = (await browser.storage.local.get("bpaStatus")).bpaStatus;
  const status =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const container = document.querySelector("#status")!;
  container.replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    const fieldValue = status[key];
    detail.textContent = Array.isArray(fieldValue)
      ? fieldValue.join(", ")
      : String(fieldValue ?? "—");
    container.append(term, detail);
  }
  document.querySelector("#error")!.textContent = status.lastError
    ? `最后错误：${status.lastError}`
    : "";

  const assistance = await panel.read();
  const badge = document.querySelector("#assistance-state")!;
  badge.textContent = ASSISTANCE_SUPERVISION_LABELS[assistance.supervision];
  badge.setAttribute("data-state", assistance.supervision);
  const taskList = document.querySelector("#assistance-tasks")!;
  taskList.replaceChildren();
  for (const task of assistance.tasks) {
    const item = document.createElement("li");
    const heading = document.createElement("strong");
    const metadata = document.createElement("span");
    heading.textContent = ASSISTANCE_SUMMARY_LABELS[task.summaryCode];
    metadata.textContent = [
      task.profileId,
      task.mode,
      task.status,
      task.deadline ? `截止 ${task.deadline}` : undefined,
      `任务 ${task.taskId}`
    ]
      .filter(Boolean)
      .join(" · ");
    item.append(heading, metadata);
    taskList.append(item);
  }
  document.querySelector("#assistance-empty")!.toggleAttribute(
    "hidden",
    assistance.tasks.length > 0
  );
}

void render();
document
  .querySelector("#design-mode-prepare")!
  .addEventListener("click", () => void prepareDesignModeBinding());
