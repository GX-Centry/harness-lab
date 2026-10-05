# 00 · 开发环境说明与避坑指南

> 本文档记录本项目的开发环境事实核查结论与工程规避策略。
> 核查时间：2026-10-05（Windows 10 22H2 / PowerShell 5.1 / Node 26）。
> 环境发生变化（换机、升级系统、更换代理）后，请先更新本文档，再修改代码。

---

## 1. 硬件与系统

| 项 | 实测值 | 对本项目的影响 |
|---|---|---|
| 操作系统 | Windows 10 专业版 22H2（10.0.19045，非 Win11） | 部分「现代终端」特性不可假设；脚本一律按 PS 5.1 兼容写 |
| CPU | AMD Ryzen 7 3750H（4 核 8 线程） | 足够；并行测试与构建注意不要过度并发 |
| 内存 | 15.8 GB | Vitest 用 `pool: 'forks'`，控制 worker 数量 |
| 磁盘 | F: 可用 875 GB（本项目所在盘） | 无空间约束 |

## 2. 运行时与工具链

| 工具 | 实测版本 | 备注 |
|---|---|---|
| Node.js | v26.8.1 | 支持原生 type-stripping；`node:sqlite` 已内置稳定 |
| pnpm | 11.21.0 | 本项目首选包管理器（npm 11.19 备用） |
| Python | 3.14.7（默认）/ 3.12 | 本项目为 TS 工程，Python 仅用于辅助脚本（如需要） |
| git | 2.55.0.windows.3 | `core.longpaths=true` 已开；**全局未配置 user.name/email**（若需 commit 先补） |
| winget | 1.29.380 | 缺工具时可用 |
| uv / bun | 未安装 | 本项目不需要 |

## 3. 网络与代理（重要）

- 本机通过 **Clash Verge**，代理端口 `127.0.0.1:7890`，系统代理已启用；
- **但环境变量 `HTTPS_PROXY`/`HTTP_PROXY` 为空** —— 命令行工具默认不走代理；
- 实测结论（2026-10-05）：
  - `github.com` 直连可达；`api.anthropic.com`、`api.deepseek.com` 直连返回 403/401（可达，仅缺 Key）；
  - **`registry.npmjs.org` 直连失败（CERT_HAS_EXPIRED，链路证书干扰）**；
  - 显式走 `127.0.0.1:7890` 代理后：`npm ping` → PONG，registry → 200。

### 规避策略（已执行）

1. pnpm 全局配置了 `proxy` / `https-proxy` → `http://127.0.0.1:7890`（写入用户级 ~/.npmrc）；
2. git 全局已配 `http.proxy`；
3. 备选方案：若代理不可用，切换镜像 `pnpm config set registry https://registry.npmmirror.com`（实测 200 可达）。

## 4. 编码与 PowerShell 5.1 坑点清单

| # | 坑 | 具体表现 | 规避策略（项目约束） |
|---|---|---|---|
| 1 | PS 5.1 不支持 `&&` | `cmd1 && cmd2` 报错 | 一律使用 `;` 分隔命令 |
| 2 | 控制台默认代码页 936（GBK） | 外部命令的中文输出经管道出现乱码/转义（`\x3b` 等） | 不依赖控制台输出传递数据；必要步骤先 `chcp 65001` + 设置 `[Console]::OutputEncoding` |
| 3 | PS 5.1 `>` / `Out-File` 默认写 **UTF-16LE** | shell 重定向生成的文本文件编码错误、带 BOM | **严禁用 shell 重定向写代码/配置/文档**；一律通过 IDE 文件工具或 Node 脚本写文件 |
| 4 | 环境变量代理未设置 | curl/npm/pnpm 直连失败 | 代理已固化进 pnpm/git 全局配置；临时命令可先 `$env:HTTPS_PROXY='http://127.0.0.1:7890'` |
| 5 | ExecutionPolicy = RemoteSigned | 本地 .ps1 可直接运行 | 无阻碍；npx/tsx 正常 |
| 6 | git autocrlf 未配置 | 换行符可能漂移 | 仓库级 `.gitattributes` 已强制 `eol=lf` |
| 7 | Windows 路径长度 | 深层 node_modules | `core.longpaths=true` 已开，且 pnpm 使用符号链接结构，实测安全 |

## 5. 项目级执行规范（写代码/跑命令时必须遵守）

1. **文件写入**：只用 IDE 文件工具或 Node 脚本；不用 PowerShell 重定向；
2. **编码**：全仓库 UTF-8（无 BOM）+ LF（`.editorconfig`/`.gitattributes` 已固定）；
3. **命令分隔**：PowerShell 中用 `;`，不用 `&&`；
4. **网络命令**：依赖已固化的 pnpm 代理配置；如手动跑 curl 需显式 `--proxy http://127.0.0.1:7890`；
5. **数据落盘**：运行时产物（sqlite / 日志）统一写入 `data/` 目录（已 gitignore），支持 `data/` 可清空重建；
6. **密钥**：任何 API Key 只从环境变量读取，严禁写入代码、文档或提交历史。

---

*下一篇：`01-architecture.md` —— 总体架构与数据流。*
