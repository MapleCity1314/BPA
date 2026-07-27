# Bridge / Gateway 实验

该目录用于验证 BPA Browser Bridge 与 Gateway 的通信和恢复语义。

这里使用的 `bpa-bridge-experiment/0` 只是实验格式，不是正式通用协议。

## 当前实验范围

- 浏览器实例配对。
- 节点能力协商。
- Gateway 节点调度。
- Command ACK。
- Result ACK。
- 幂等键。
- 结果重复上报去重。
- Bridge 重连和未确认结果补发。
- Gateway JSON 状态持久化和进程重启恢复。
- `uncertain` 终态保护。

## 运行

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm demo
```

## 边界

- Gateway 支持内存或 JSON 文件实验状态存储。
- Bridge 模拟器用于故障注入；真实扩展 Bridge 已接入重点项插件。
- 配对令牌是实验值，没有实现正式设备身份。
- 消息字段会根据实验结果变化。
