import { browser } from "wxt/browser";

const labels: Record<string, string> = {
  host: "Native Host",
  core: "Local Core",
  protocol: "协议",
  sessionId: "会话",
  currentTask: "当前任务",
  permissions: "权限",
  updatedAt: "更新时间"
};

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
    const value = status[key];
    detail.textContent = Array.isArray(value)
      ? value.join(", ")
      : String(value ?? "—");
    container.append(term, detail);
  }
  document.querySelector("#error")!.textContent = status.lastError
    ? `最后错误：${status.lastError}`
    : "";
}

void render();
