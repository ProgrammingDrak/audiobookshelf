#!/usr/bin/env python3
"""Audit already tested image artifacts before publishing; never run image code."""
import hashlib
import json
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

root, revision = Path(sys.argv[1]), sys.argv[2]
assert re.fullmatch(r'[a-f0-9]{40}', revision)

def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()

for arch in ['amd64', 'arm64']:
    record = json.loads((root / ('docker-image-' + arch + '.json')).read_text())
    assert record['revision'] == revision and record['architecture'] == arch
    assert re.fullmatch(r'sha256:[a-f0-9]{64}', record['image_id'])
    assert record['archive'] == 'abs-frontend-' + arch + '.docker.tar.gz'
    archive = root / record['archive']
    assert archive.stat().st_size == record['archive_bytes']
    assert hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() == record['archive_sha256']
    docker('image', 'load', '--input', str(archive))
    image = json.loads(docker('image', 'inspect', record['image_id']))[0]
    assert image['Id'] == record['image_id'] and image['Os'] == 'linux' and image['Architecture'] == arch
    config = image['Config']
    assert config['User'] == 'node' and not config.get('Volumes')
    assert config['Labels']['org.opencontainers.image.revision'] == revision
    assert config['Labels']['org.opencontainers.image.licenses'] == 'GPL-3.0-only'
    assert config['Labels']['org.opencontainers.image.source'] == 'https://github.com/ProgrammingDrak/audiobookshelf'
    assert set(config['Env']) == {'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=24.21.0', 'YARN_VERSION=1.22.22', 'NODE_ENV=production', 'HOST=0.0.0.0', 'PORT=8080', 'CONTAINER_MODE=1'}
    container = docker('create', '--platform', 'linux/' + arch, record['image_id'])
    try:
        with tempfile.TemporaryDirectory(prefix='abs-image-audit-') as temporary:
            app = Path(temporary) / 'app'
            docker('cp', container + ':/app', str(app))
            assert {p.name for p in app.iterdir()} == {'client', 'frontend-gateway', 'LICENSE', 'release.json', 'source.tar.gz'}
            metadata = json.loads((app / 'release.json').read_text())
            assert metadata == {'revision': revision, 'source': 'https://github.com/ProgrammingDrak/audiobookshelf/tree/' + revision, 'clientVersion': '2.37.1'}
            assert 'GNU GENERAL PUBLIC LICENSE' in (app / 'LICENSE').read_text()
            assert (app / 'client/dist/index.html').is_file()
            with tarfile.open(app / 'source.tar.gz', 'r:gz') as source:
                names = source.getnames()
                assert {'LICENSE', 'client/package-lock.json', 'client/package.json', 'frontend-gateway/server.mjs', 'frontend-gateway/docker/Dockerfile'} <= set(names)
                assert not any(n.startswith(('/', '../', 'audiobooks/', 'config/', 'metadata/', 'media/')) or n.endswith(('/.env', '/runtime.env')) or n == '.env' for n in names)
                assert source.extractfile('LICENSE').read() == (app / 'LICENSE').read_bytes()
                assert source.extractfile('frontend-gateway/server.mjs').read() == (app / 'frontend-gateway/server.mjs').read_bytes()
                assert json.load(source.extractfile('client/package.json'))['version'] == metadata['clientVersion']
            print('Audited exact tested ' + arch + ' image: compiled UI/gateway, GPL/source, no runtime configuration or data')
    finally:
        docker('rm', container)
