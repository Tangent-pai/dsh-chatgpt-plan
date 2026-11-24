# Testing and release checks

Use Node.js 24 and Python 3.9 or later. From the repository root:

```sh
npm ci --ignore-scripts
npm test
npm audit --omit=dev --audit-level=low
```

The default test suite uses simulated authorization, transport and quota data. It does not read account files, open a browser, send user data, or consume subscription quota.

## Additional checks on Windows x64

Generate the protocol schema from the pinned optional Codex binary (no login is required), then run the offline image-bridge tests. PowerShell:

```powershell
& '.\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe' app-server generate-json-schema --out codex-protocol
npm run test:image
```

`test.mjs` and `specs.test.mjs` additionally need a DSH Desktop installation. Run them under the DSH Desktop Electron executable with `ELECTRON_RUN_AS_NODE=1`, and set `DSH_INSTALL_DIR` to the installed DSH package directory inside `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh`. These are local integration checks, not live browser sign-in tests.

`python package-release.py` builds the local install archive from an explicit source list. It does not overwrite an existing archive. Build from a clean checkout and review its file list before distribution.

Dependency auditing and regression tests are release checks, not independent certification. A passing audit only means that the registry did not report a matching known advisory at the time of the check.
