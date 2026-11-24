from pathlib import Path
import tarfile, json
root = Path(__file__).resolve().parent
package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
files = ['package.json', 'index.js', 'specs.js', 'image-bridge.js', 'codex-rpc.js', 'usage.js', 'auth-settings.js', 'client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']
output = root / ('local-dsh-chatgpt-plan-' + package['version'] + '.tgz')
with tarfile.open(output, 'x:gz', format=tarfile.PAX_FORMAT) as archive:
    for name in files:
        path = root / name
        assert path.is_file() and path.resolve().is_relative_to(root)
        archive.add(path, arcname='package/' + name, recursive=False)
with tarfile.open(output, 'r:gz') as archive:
    assert archive.getnames() == ['package/' + name for name in files]
print('PACKAGED', output, 'files', len(files))
