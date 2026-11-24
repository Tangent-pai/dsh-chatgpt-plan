# Third-party software and assets

This repository is an independent plugin. [MIT](LICENSE) applies to its original source, documentation and project icon. It does not relicense third-party software. The project icon is a custom geometric SVG drawn for this repository; it contains no vendor logo or third-party artwork.

| Component | Role | License and source |
| --- | --- | --- |
| OpenAI Codex CLI and its optional native platform packages, `0.169.0` | Official local App Server for device sign-in, Codex usage and image generation. Installed from npm, not included in this repository or plugin archive. | [Apache-2.0](https://github.com/openai/codex/blob/rust-v0.169.0/LICENSE) · [Source](https://github.com/openai/codex/tree/rust-v0.169.0) |
| `pngjs` `7.0.0` | Decodes and validates generated PNG images. Installed from npm, not bundled in the archive. | [MIT](https://github.com/pngjs/pngjs/blob/v7.0.0/LICENSE) · [npm](https://www.npmjs.com/package/pngjs/v/7.0.0) |
| DeepSeek Harness and `@earendil-works/pi-ai` `1.3.0` | The plugin calls the host's configuration, authorization, model and client interfaces and uses its bundled PiAi adapter. These packages come from the user's DSH installation; the plugin does not ship them. | [DeepSeek Harness source](https://github.com/deepseek-ai/deepseek-harness) · [PiAi npm package](https://www.npmjs.com/package/@earendil-works/pi-ai/v/1.3.0). See the respective distributions for their license notices. |

The offline image-bridge contract test reads schemas emitted by the pinned Codex executable under its upstream license. Generate them locally; generated schemas and provider documentation are not part of this repository or the installable archive.

OpenAI, ChatGPT, Codex and DeepSeek Harness identify their respective products. This project is not published by or affiliated with their vendors.
