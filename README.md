# dsh-chatgpt-plan

## English

An independent Windows x64 plugin for DSH Desktop. Use your ChatGPT subscription for chat, and official Codex for images and its quota—no API key needed. Tested with DSH 0.2.2-rc.5 (declared `>=0.2.2-rc.3 <0.3.0`).

### Install

In DSH Desktop, select **Plugins → Add plugin** in the sidebar, paste the following Git spec into the package field, and click **Install** (no local build required):

```text
git+https://github.com/Tangent-pai/dsh-chatgpt-plan.git#6cdfe0ad5e3bb74503a6e5a9b88b763b73db0ad1
```

If the DSH CLI is available, the equivalent command for the CLI's current profile is:

```bash
dsh plugin add "git+https://github.com/Tangent-pai/dsh-chatgpt-plan.git#6cdfe0ad5e3bb74503a6e5a9b88b763b73db0ad1"
```

To install from a local checkout instead, run `python package-release.py` to create a `.tgz` archive and paste its absolute path into the same desktop installation field.

Quit and reopen DSH Desktop after an upgrade.

#### Ask DSH Agent to install it

If your DSH Agent has access to the `plugin_manager` tool, you can copy and send this prompt to have it install and enable the plugin for you:

```text
Please install and enable the plugin from https://github.com/Tangent-pai/dsh-chatgpt-plan for my current DSH profile using your plugin_manager tool (action: install_bundle) with the install target:
git+https://github.com/Tangent-pai/dsh-chatgpt-plan.git#6cdfe0ad5e3bb74503a6e5a9b88b763b73db0ad1

Once done, let me know whether activation succeeded right away or requires a restart, and leave login to me.
```

### Sign in

Open **Settings → Built-in plugins → ChatGPT Plan**:

- **Chat:** Sign in on the official web page that opens, then choose a ChatGPT Plan model.
- **Images and quota:** Sign in to Codex separately. Copy the one-time device code from Settings and enter it on the official page.

### Use

- Just ask to draw in chat—image generation uses fixed `gpt-image-2`.
- Check approximate remaining quota and reset time under **Codex Subscription Usage** below the Cost Meter, or run `/chatgpt-plan usage`. This tracks Codex quota (shared with images), not text quota.
- If a model is missing, run `/chatgpt-plan models` to refresh the list.

License and notices: [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## 简体中文

面向 Windows x64 的独立 DSH Desktop 插件。直接用你的 ChatGPT 订阅聊天，用官方 Codex 生图和看额度，不用填 API key。已在 DSH 0.2.2-rc.5 测试，声明兼容 `>=0.2.2-rc.3 <0.3.0`。

### 安装

在 DSH Desktop 中，从侧边栏选择 **插件 → 添加插件**，将以下 Git 地址粘贴到包输入框中，然后点击 **安装**（无需本地构建）：

```text
git+https://github.com/Tangent-pai/dsh-chatgpt-plan.git#6cdfe0ad5e3bb74503a6e5a9b88b763b73db0ad1
```

如果有 DSH CLI，可在 CLI 当前配置下运行等效命令：

```bash
dsh plugin add "git+https://github.com/Tangent-pai/dsh-chatgpt-plan.git#6cdfe0ad5e3bb74503a6e5a9b88b763b73db0ad1"
```

如需从本地检出的仓库安装，运行 `python package-release.py` 生成 `.tgz` 文件，再将其绝对路径粘贴到同一个桌面端安装输入框中。

升级后请退出并重新打开 DSH Desktop。

#### 让 DSH Agent 安装

如果你使用的 DSH Agent 支持 `plugin_manager` 工具，可以直接复制下面这段提示词，让它帮你安装并启用插件：

```text
请使用你的 plugin_manager 工具（action 为 install_bundle），将 https://github.com/Tangent-pai/dsh-chatgpt-plan 插件安装并启用到我当前的 DSH profile，安装目标为：
git+https://github.com/Tangent-pai/dsh-chatgpt-plan.git#6cdfe0ad5e3bb74503a6e5a9b88b763b73db0ad1

完成后请告诉我插件是已直接生效还是需要重启，登录步骤留给我自己完成即可。
```

### 登录

进入 **设置 → 内置插件 → ChatGPT Plan**：

- **文字聊天**：点登录会打开官方网页，完成登录后选一个 ChatGPT Plan 模型就能直接聊。
- **生图与额度**：Codex 需要单独登录。从设置里复制一次性设备码，填到官方页面里就行。

### 使用

- 想画图直接在聊天里说就行，生图模型固定为 `gpt-image-2`。
- Cost Meter 下方的 **Codex Subscription Usage** 会显示大概的剩余额度和重置时间，也可以输入 `/chatgpt-plan usage` 查看。这里看的是 Codex 额度（生图也共用这份额度），不是文本聊天额度。
- 如果发现模型列表里少了模型，发一条 `/chatgpt-plan models` 刷新一下。

许可协议与第三方声明见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
