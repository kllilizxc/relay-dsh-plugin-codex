# DeepSeek Harness 的 Codex 对话插件

本插件在 DeepSeek Harness（DSH）中加入 Codex 对话后端，使用官方 Codex App Server，让每个 DSH 会话持续连接同一个 Codex 线程。

此仓库基于 MIT 许可的 Relay Codex 插件 `0.2.5-rc.1` 源码。原版权声明保留在 [LICENSE](LICENSE)。本 fork 仅通过 GitHub 分发，不发布到 npm。

[English](README.md)

## 本 fork 的改动

- 没有 DSH 会话的纯文本、无工具请求使用临时 Codex 线程，并在完成或失败后释放。
- 切换 Codex 提供者时，如果当前模型仍可用，就保留用户已选择的模型。
- Codex 会话输入 `/` 可查询当前工作区的 Codex 原生技能。选择后插入原生 `$skill` 引用；同名技能使用路径消歧。

## 从 GitHub 安装

1. 安装 Node.js 22.13 或更新版本以及 `pnpm`。
2. 使用官方 Codex 客户端完成登录，例如运行 `codex login`。
3. 停止 DSH Web，用 GitHub 页面提供的 HTTPS 克隆地址安装此仓库：

   ```sh
   dsh plugin --profile web add 'git+https://github.com/<account>/relay-dsh-plugin-codex.git#main'
   dsh web
   ```

4. 新建会话，选择工作区和 **Codex** 模式。

原生技能菜单需要 DSH 提供 `inputTriggers` 客户端服务和会话查询服务。本 fork 尚未对 `package.json` 中声明的所有 DSH 版本逐一完成兼容性验收。

## 开发

源码、生成的 `lib/` 产物和定向测试放在同一仓库。构建时将 `DSH_ROOT` 指向兼容的 DSH 源码目录，再运行 `npm run build`。修改后默认只运行相关测试。

仓库不包含本机会话数据或兼容性实测日志。
