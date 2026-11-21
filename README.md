# Codex Capsule

Windows 版 Codex 桌面端的输入框状态栏。三个圆角胶囊放在输入框内部，与权限按钮、模型选择器和发送按钮同一行。将指针移到胶囊上可查看明细，点击可固定，再点一次或按 Esc 收起。

**让 Codex 帮你安装**　把下面这句话发给能在你电脑上运行 PowerShell 的 Codex：

> 请帮我在这台 Windows 电脑上安装或更新 Codex Capsule：https://github.com/siwangchenfu/Codex-Capsule 。先检查 Node.js 22.13+ 和 Woodfish 是否已连接 Codex，再按 README 运行安装脚本，最后打开一个已有聊天，确认输入框里能看到胶囊。

安装器会启动本地组件并添加当前用户的登录启动项。龙娘是可选组件。

| 胶囊 | 数据与含义 |
| --- | --- |
| 速度 · 首字 | 最近一个已完成助手正文片段的 token 数除以该片段的生成时间。首字等待使用当前轮次完成事件里的 `time_to_first_token_ms`。本轮尚无记录时显示「—」。 |
| 上下文 | 展示最近一笔用量的缓存命中率（缓存读取 / 输入）、占用比例及已用 / 容量。明细用 K（1K = 1,000 tokens）。字段可核对时分成未命中输入、缓存读取、推理输出、其余输出；缓存写入单列，不重复计入总量。 |
| 剩余额度 | 面板按行显示额度窗口、剩余百分比、圆环、距重置还有多久。将指针移到倒计时上可看具体重置时间。Plus 有记录时显示 5 小时和周额度，Pro 显示周额度。 |
| 请求异常（按需出现） | 点击或悬停可看中文原因、重试阶段和已识别的技术信息。连接中断、超时、模型繁忙、请求受限和明确的额度耗尽分别显示。普通 HTTP 429 只标为请求受限。 |

异常信息来自聊天事件，以及能同时匹配当前聊天和轮次的本机 Codex 重试日志。自动重试有计数时显示次数；继续输出或开启下一轮后清除重试提示。无法归属到当前聊天的全局日志不进入面板。客户端未写下的错误可能只出现在原生界面。

速度点的颜色区分速度档位，上下文圆环显示占比。窗口变窄时文字缩短；空间进一步收窄时胶囊行支持横向滚动，也可用 Tab 依次聚焦。

## 安装

适用于 Windows 上的本地 Codex 桌面聊天。本版需要已在 Codex 生效的 Woodfish，以及可从 PowerShell 运行的 Node.js 22.13+。实测环境为 Codex 26.1117.4957.0、Woodfish 8.1.5 和 Node.js 24。龙娘是可选的额度快照来源。[Woodfish 项目](https://github.com/woodfishhhh/Woodfish-Theme) · [龙娘项目](https://github.com/InhamiRei/Codex-DragonGirl)

从本仓库下载并解压源码，在该目录打开 PowerShell，运行：

```powershell
.\install.ps1
```

安装器将程序放入当前用户的 `%LOCALAPPDATA%\CodexCapsule`，立即启动，并在 Windows 启动文件夹添加 `Codex Capsule.lnk`。背景信息窗口可在 Codex 设置中自行开关。更新时从新版源码目录再次运行安装脚本。

卸载：

```powershell
& "$env:LOCALAPPDATA\CodexCapsule\uninstall.ps1"
```

## 运行方式

后台进程使用 Woodfish 已在本机启用的回环调试连接，将组件挂载到 Codex 输入框内。该连接具备操作本地应用界面的能力。Capsule 只连接本机的 Codex 页面，运行期间只传递当前界面所需的统计字段，不向外部服务上传数据。

程序读取 `CODEX_HOME`（默认为 `~/.codex`）中的 SQLite 索引和当前聊天的 JSONL 事件。以可见输入框的聊天 ID 定位文件，写入显示前再次核对 ID，切换聊天时清空旧读数。首次读取从日志尾部开始，之后只处理新增字节。较旧的日志若缺少所需字段，或记录超出读取范围，对应位置显示「—」。

剩余额度取当前聊天记载的 Codex 账户窗口；安装龙娘时，还会比较同一数据目录的账户快照，优先采用采样时间较新的记录。额度属于账户，切换同一账户的聊天时可以相同。可在明细面板查看时间，判断快照新旧。

如果界面未出现，先确认 Woodfish 已连接 Codex，再查看 `%LOCALAPPDATA%\CodexCapsule\status.json`。正常附着时为 `active`，等待可用窗口时为 `waiting`。桌面端更新可能改变 DOM 属性或本地日志字段，遇到这种情况需要重新验证适配。

## 验证

- 在 Windows 实机切换两个上下文占用不同的已有聊天，按 A → B → A 返回。两边读数分别与各自日志一致，B 页拒绝 A 的迟到结果。
- 在常规宽度和 540 像素输入框宽度检查胶囊位置、权限按钮和模型选择器。实测 Woodfish 的输入光标、聚焦光晕、原生「添加文件」提示框及胶囊自己的详情面板。
- Pro 的显示在实机核对。Plus 的双窗口、缺失窗口和到期窗口使用构造数据测试。生成速度按正文片段统计，首字按轮次统计。

```powershell
node --test test.mjs
# 以下测试会在两个已存在且有用量记录的聊天间切换，结束后回到原聊天。
node verify-live.mjs
```

桌面胶囊的交互参考了 [agy-capsule](https://github.com/Lumidarin/agy-capsule)，紧凑布局参考了 [agy-capsule-cli](https://github.com/Lumidarin/agy-capsule-cli)。本项目使用 Codex 自身的数据格式，是个人维护的本地扩展。
