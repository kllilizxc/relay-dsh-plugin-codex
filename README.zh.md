# DeepSeek Harness 的 Codex 对话插件

本插件在 DeepSeek Harness（DSH）中加入 Codex 对话后端，使用官方 Codex App Server，让每个 DSH 会话持续连接同一个 Codex 线程。

此仓库基于 MIT 许可的 Relay Codex 插件 `0.2.5-rc.1` 源码。原版权声明保留在 [LICENSE](LICENSE)。本 fork 仅通过 GitHub 分发，不发布到 npm。

[English](README.md)

## 本 fork 的改动

- 没有 DSH 会话的纯文本、无工具请求使用临时 Codex 线程，并在完成或失败后释放。
- 切换 Codex 提供者时，如果当前模型仍可用，就保留用户已选择的模型。
- Codex 会话输入 `/` 可查询当前工作区的 Codex 原生技能。选择后插入原生 `$skill` 引用；同名技能使用路径消歧。
- 适配 DSH `0.2.1-rc.2` 与 React 19：Codex 运行时设置改用原生 `Config`，工具活动结果使用 tool 角色消息，持久化文件附件以可读宿主路径传给 Codex。peer 依赖已固定到这些版本。

## 从 GitHub 安装

1. 安装 Node.js 22.13 或更新版本以及 `pnpm`。
2. 使用官方 Codex 客户端完成登录，例如运行 `codex login`。
3. 停止 DSH Web，用 GitHub 页面提供的 HTTPS 克隆地址安装此仓库：

   ```sh
   dsh plugin --profile web add 'git+https://github.com/<account>/relay-dsh-plugin-codex.git#main'
   dsh web
   ```

4. 新建会话，选择工作区和 **Codex** 模式。

本 fork 面向 DSH `0.2.1-rc.2` 与 React 19，peer 依赖已固定到这些版本。原生技能菜单需要 DSH 提供 `inputTriggers` 客户端服务和会话查询服务。把最终答复中的绝对路径文件链接渲染为可点击按钮，需要 DSH 前端的 `MarkdownText` 支持路径链接；在官方 DSH `0.2.1-rc.2` 上这些链接只显示为普通锚文本。

## 开发

### 宿主维护任务的临时会话

宿主可在已附加 DSH agent 的 Relay `GenerateOptions` 请求中加入 `relayCodexEphemeral: true`，并在该会话首次创建 Codex 线程前设置。临时线程保留 agent 的工具、实际沙箱权限、审批与活动事件。该字段是宿主专用的命名空间选项；不要将维护任务标签放入 `GenerateOptions.purpose`，后者会进入用于标题与压缩的独立无工具路径。

临时模式在后续请求中持续生效，不能转换已有持久线程，也不能将临时绑定降级为持久绑定。agent 释放时，绑定立即失效；Relay 等待当前 turn 结束后释放临时线程，并保留 DSH 到 Codex 的绑定作为失效标记，重新附加 agent 也不能恢复。重启、上下文释放或工具集合变化后会明确报错，不会创建替代线程或重放已执行的工作。新的维护工作应使用新的 DSH 会话。

使用新上下文的 DSH 子 agent 通过 DSH 持久化的 `origin`、`parentSession` 与 `isSeeded` 元数据，从已知临时父会话继承临时模式。Codex 原生子 agent 也会继承父线程的临时配置。内置 Codex 0.166 App Server 无法恢复临时线程，也无法将其 fork 为另一 DSH 会话。当已验证父会话或目标子会话使用临时模式时，Relay 会拒绝继承历史的 DSH fork，并持久化该阻塞状态，重启后也不会创建新线程重放。临时子会话带有继承历史、却没有已完成 Codex replay 标记时，也会明确失败。普通持久 DSH fork 保持原行为。

### 本地验证

源码、生成的 `lib/` 产物和定向测试放在同一仓库。构建时将 `DSH_ROOT` 指向兼容的 DSH 源码目录，再运行 `npm run build`。修改后默认只运行相关测试。

仓库不包含本机会话数据或兼容性实测日志。
