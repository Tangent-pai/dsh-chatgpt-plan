# dsh-chatgpt-plan

## English

An independent Windows x64 plugin for DSH Desktop. Use your ChatGPT subscription for chat, and official Codex for images and its quota—no API key needed. Tested with DSH 0.2.2-rc.5 (declared `>=0.2.2-rc.3 <0.3.0`).

### Install

Run `python package-release.py` to build a local `.tgz`, then install it from **Plugins → Add plugin** in DSH Desktop. Quit and reopen DSH after upgrades.

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

运行 `python package-release.py` 在本地打出一个 `.tgz` 包，再到 DSH Desktop 的 **Plugins → Add plugin** 里选中安装。升级插件后记得退出再重新打开 DSH。

### 登录

进入 **设置 → 内置插件 → ChatGPT Plan**：

- **文字聊天**：点登录会打开官方网页，完成登录后选一个 ChatGPT Plan 模型就能直接聊。
- **生图与额度**：Codex 需要单独登录。从设置里复制一次性设备码，填到官方页面里就行。

### 使用

- 想画图直接在聊天里说就行，生图模型固定为 `gpt-image-2`。
- Cost Meter 下方的 **Codex Subscription Usage** 会显示大概的剩余额度和重置时间，也可以输入 `/chatgpt-plan usage` 查看。这里看的是 Codex 额度（生图也共用这份额度），不是文本聊天额度。
- 如果发现模型列表里少了模型，发一条 `/chatgpt-plan models` 刷新一下。

许可协议与第三方声明见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
