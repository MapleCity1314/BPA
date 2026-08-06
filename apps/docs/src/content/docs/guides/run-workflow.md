---
title: 启动 Workflow
description: 选择正式 Workflow、填写输入、绑定浏览器资源并观察一次 Run。
---

BPA 只运行已经人工发布、版本固定的 Workflow。启动时会把编译后的 IR2、权限、
风险策略、Node/Adapter 版本和浏览器资源绑定一起冻结。

## 通过工作台启动

1. 打开“启动任务”。
2. 选择一个已发布的 Workflow 和精确版本。
3. 填写页面显示的业务输入。
4. 为每个 Resource Slot 选择满足 Origin、能力和认证要求的 Browser Session。
5. 核对只读范围和风险提示，然后启动。

缺少必需 Slot 时工作台不会提交 Run。一个 Slot 绑定到精确 Session，而不是“任意
可用 Chrome”；恢复时也不会偷偷换到其他登录上下文。

## 通过 CLI 启动

CLI 适合诊断不需要 Browser Resource Binding 的 Workflow：

```bash
bpa run <workflow-id> \
  --version <exact-version> \
  --input '{"key":"value"}'
```

在 Windows PowerShell、批处理或多层自动化工具中，不要把含双引号的 JSON 继续嵌入
命令字符串。`workflow-run` 支持从 UTF-8 文件读取输入，避免 PowerShell、`cmd.exe` 和
CLI 之间发生二次转义：

```powershell
bpa workflow-run <workflow-id> `
  --version <exact-version> `
  --input-file C:\BPA\run\workflow-input.json
```

`--input` 与 `--input-file` 不能同时使用，输入文件上限为 64 KiB。

当前 CLI 的 `run` 命令不提供资源槽位参数。需要绑定浏览器的 v1alpha3 Workflow
应从工作台启动，或由受信 Control Client 显式提交 `resourceBindings`。

## 运行期间

Run 时间线展示：

- 已进入的步骤和当前状态。
- Assistance 暂停点。
- 节点重试、超时和失败。
- 最终成功、失败、取消或 `uncertain`。

刷新或关闭 Console 不会取消 Run。Console Host、Core 或 Chrome 重启后的恢复语义
见[故障与恢复](../recovery/)。

## 取消不是回滚

取消表达“停止后续工作”的意图。已经开始的页面写动作如果无法证明结果，必须进入
`uncertain`；当前公开业务流程仍保持只读，不开放保存或发布。
