#!/usr/bin/env python3
"""Host-owned Docker updater; Python 3.9+ standard library, no app socket mount."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
import urllib.request
from pathlib import Path

REPOSITORY = 'ProgrammingDrak/audiobookshelf'
REVISION = re.compile(r'^[a-f0-9]{40}$')
IMAGE_ID = re.compile(r'^sha256:[a-f0-9]{64}$')


def atomic_json(destination, value):
    temporary = destination.with_name(destination.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, destination)


def architecture(value):
    aliases = {'linux/amd64': 'amd64', 'linux/x86_64': 'amd64', 'linux/arm64': 'arm64', 'linux/aarch64': 'arm64'}
    if value.strip() not in aliases:
        raise ValueError('Supported Docker host platforms: linux/amd64 and linux/arm64')
    return aliases[value.strip()]


def validate_record(record, arch):
    if not REVISION.fullmatch(record.get('revision', '')) or not IMAGE_ID.fullmatch(record.get('image_id', '')):
        raise ValueError('Invalid immutable image/revision')
    if record.get('architecture') != arch or not re.fullmatch(r'[a-f0-9]{64}', record.get('archive_sha256', '')):
        raise ValueError('Invalid platform/checksum')
    if record.get('archive') != 'abs-frontend-' + arch + '.docker.tar.gz':
        raise ValueError('Unexpected Docker archive name')
    return record


class Docker:
    def __init__(self, home, project='abs-frontend-drake', wait_seconds=75):
        if not re.fullmatch(r'abs-frontend-[a-z0-9][a-z0-9-]{0,50}', project):
            raise ValueError('Updater must use a dedicated abs-frontend project')
        self.home, self.project, self.wait_seconds = Path(home).resolve(), project, wait_seconds

    def run(self, arguments, image=None, input_file=None):
        env = dict(os.environ)
        for name in ['ABS_FRONTEND_IMAGE', 'ABS_UPSTREAM', 'PUBLIC_ORIGIN', 'EXPECTED_BACKEND_VERSION', 'ABS_FRONTEND_PORT', 'COMPOSE_FILE', 'COMPOSE_PROFILES']:
            env.pop(name, None)
        if image:
            env['ABS_FRONTEND_IMAGE'] = image
        process = subprocess.run(['docker'] + arguments, env=env, stdin=input_file, capture_output=True, text=True)
        if process.returncode:
            raise RuntimeError('Dedicated frontend Docker operation failed (exit ' + str(process.returncode) + ')')
        return process.stdout.strip()

    def compose(self, arguments, image):
        return self.run(['compose', '--project-name', self.project, '--project-directory', str(self.home), '--env-file', str(self.home / 'runtime.env'), '-f', str(self.home / 'compose.yaml')] + arguments, image)

    def arch(self):
        return architecture(self.run(['info', '--format', '{{.OSType}}/{{.Architecture}}']))

    def existing_project(self):
        return bool(self.run(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + self.project]))

    def configuration(self, image):
        data = json.loads(self.compose(['config', '--format', 'json'], image))
        if set(data.get('services', {})) != {'frontend'}:
            raise ValueError('Compose must contain only the dedicated frontend service')
        service = data['services']['frontend']
        if service.get('volumes') or service.get('devices') or service.get('privileged') or service.get('cap_add') or service.get('network_mode') or service.get('user') != '1000:1000':
            raise ValueError('Frontend must have no host mounts, elevated privileges, or host networking')
        if not service.get('read_only') or service.get('cap_drop') != ['ALL'] or 'no-new-privileges:true' not in service.get('security_opt', []):
            raise ValueError('Frontend runtime protections missing')
        ports = service.get('ports', [])
        if len(ports) != 1 or ports[0].get('host_ip') != '127.0.0.1' or ports[0].get('target') != 8080:
            raise ValueError('Frontend port must publish only to host loopback')
        fields = set(service.get('environment', {}))
        required = {'HOST', 'PORT', 'CONTAINER_MODE', 'ABS_UPSTREAM', 'PUBLIC_ORIGIN'}
        if not required <= fields or fields - required - {'EXPECTED_BACKEND_VERSION'}:
            raise ValueError('Unexpected frontend environment; no tokens or revision overrides permitted')
        return data

    def verify_image(self, record):
        image = json.loads(self.run(['image', 'inspect', record['image_id']]))[0]
        if image['Id'] != record['image_id'] or architecture(image['Os'] + '/' + image['Architecture']) != record['architecture']:
            raise ValueError('Loaded image platform/digest mismatch')
        if image['Config'].get('Labels', {}).get('org.opencontainers.image.revision') != record['revision'] or image['Config'].get('User') != 'node':
            raise ValueError('Loaded image revision/non-root identity mismatch')

    def load(self, archive, record):
        if hashlib.sha256(Path(archive).read_bytes()).hexdigest() != record['archive_sha256']:
            raise ValueError('Docker archive checksum mismatch')
        # docker load accepts the gzip file directly; no shell or unsafe tar extraction.
        self.run(['image', 'load', '--input', str(archive)])
        self.verify_image(record)

    def apply(self, record):
        self.configuration(record['image_id'])
        self.verify_image(record)
        self.compose(['up', '-d', '--no-deps', '--pull', 'never', '--wait', '--wait-timeout', str(self.wait_seconds), 'frontend'], record['image_id'])

    def health(self, record):
        container = self.compose(['ps', '-q', 'frontend'], record['image_id'])
        if not re.fullmatch(r'[a-f0-9]{64}', container):
            return False
        data = json.loads(self.run(['inspect', container]))[0]
        if data['Image'] != record['image_id'] or data['State'].get('Health', {}).get('Status') != 'healthy':
            return False
        self.run(['exec', container, 'node', 'frontend-gateway/docker/healthcheck.mjs'])
        return True

    def stop(self, record):
        self.compose(['stop', 'frontend'], record['image_id'])


def rollout(home, candidate, docker):
    home = Path(home)
    current_path = home / 'current.json'
    previous = json.loads(current_path.read_text()) if current_path.exists() else None
    validate_record(candidate, docker.arch())
    if previous:
        validate_record(previous, candidate['architecture'])
        if previous == candidate:
            if not docker.health(previous):
                raise RuntimeError('Current frontend is unhealthy; inspect before continuing')
            return False
    elif docker.existing_project():
        raise ValueError('Existing dedicated-project containers found; refuse to adopt without deployment state')
    docker.configuration(candidate['image_id'])
    docker.verify_image(candidate)
    try:
        docker.apply(candidate)
        if not docker.health(candidate):
            raise RuntimeError('New frontend failed exact-image readiness')
    except Exception:
        if previous:
            docker.apply(previous)
            if not docker.health(previous):
                raise RuntimeError('Previous image restored but rollback health failed')
        else:
            docker.stop(candidate)
        blocked = home / 'blocked'
        blocked.mkdir(exist_ok=True)
        atomic_json(blocked / (candidate['revision'] + '.json'), {'revision': candidate['revision'], 'reason': 'rollout_failed'})
        raise RuntimeError('Frontend rollout failed; previous deployment retained/restored') from None
    if previous:
        atomic_json(home / 'previous.json', previous)
    atomic_json(current_path, candidate)
    return True


def download(url, destination, limit):
    request = urllib.request.Request(url, headers={'User-Agent': 'abs-frontend-docker-host-pull'})
    with urllib.request.urlopen(request, timeout=60) as response, Path(destination).open('wb') as output:
        size = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise ValueError('Release download too large')
            output.write(chunk)


def check(home, docker):
    if (home / 'PAUSED').exists():
        return 'Updates paused'
    if not (home / 'current.json').exists():
        raise ValueError('Install and verify the first Docker release before automatic checks')
    with tempfile.TemporaryDirectory(prefix='abs-frontend-update-') as temp:
        temp = Path(temp)
        download('https://api.github.com/repos/' + REPOSITORY + '/releases/latest', temp / 'release.json', 2000000)
        release = json.loads((temp / 'release.json').read_text())
        match = re.fullmatch(r'frontend-([a-f0-9]{40})', release.get('tag_name', ''))
        if not match or release.get('draft') or release.get('prerelease'):
            raise ValueError('Unexpected release channel')
        revision = match.group(1)
        if (home / 'blocked' / (revision + '.json')).exists():
            return 'Latest candidate blocked after failed rollout; inspect before retry'
        def asset(name):
            wanted = 'https://github.com/' + REPOSITORY + '/releases/download/frontend-' + revision + '/' + name
            matches = [item for item in release.get('assets', []) if item.get('name') == name]
            if len(matches) != 1 or matches[0].get('browser_download_url') != wanted:
                raise ValueError('Unexpected release asset')
            return wanted
        download(asset('docker-release.json'), temp / 'docker-release.json', 100000)
        manifest = json.loads((temp / 'docker-release.json').read_text())
        if manifest.get('revision') != revision or manifest.get('source') != 'https://github.com/' + REPOSITORY + '/tree/' + revision:
            raise ValueError('Docker release/source mismatch')
        arch = docker.arch()
        record = validate_record(manifest.get('images', {}).get(arch, {}), arch)
        if record['revision'] != revision:
            raise ValueError('Platform record revision mismatch')
        current = json.loads((home / 'current.json').read_text())
        if current == record:
            if not docker.health(current):
                raise RuntimeError('Current frontend is unhealthy')
            return 'Already current and healthy'
        download(asset(record['archive']), temp / record['archive'], 600000000)
        docker.load(temp / record['archive'], record)
        rollout(home, record, docker)
        return 'Activated ' + revision


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, required=True)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument('--check', action='store_true')
    choice.add_argument('--install', type=Path, metavar='DOCKER_RELEASE_JSON')
    choice.add_argument('--rollback', action='store_true')
    choice.add_argument('--pause', action='store_true')
    choice.add_argument('--resume', action='store_true')
    parser.add_argument('--archive-directory', type=Path)
    args = parser.parse_args()
    home = args.home.resolve()
    if not home.is_dir():
        raise ValueError('Create the host-owned deployment directory first')
    lock = home / '.docker-update-lock'
    lock.mkdir(mode=0o700)
    try:
        docker = Docker(home)
        if args.pause:
            (home / 'PAUSED').touch(mode=0o600)
            print('Updates paused')
        elif args.resume:
            (home / 'PAUSED').unlink(missing_ok=True)
            print('Updates resumed')
        elif args.rollback:
            (home / 'PAUSED').touch(mode=0o600)
            previous = json.loads((home / 'previous.json').read_text())
            rollout(home, previous, docker)
            print('Retained previous image restored; updates paused')
        elif args.install:
            manifest = json.loads(args.install.read_text())
            record = validate_record(manifest['images'][docker.arch()], docker.arch())
            if record['revision'] != manifest.get('revision'):
                raise ValueError('Initial release revision mismatch')
            directory = args.archive_directory or args.install.parent
            docker.load(directory / record['archive'], record)
            rollout(home, record, docker)
            print('Installed and verified ' + record['revision'])
        else:
            print(check(home, docker))
    finally:
        lock.rmdir()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print remote URLs, host configuration, credentials, or Docker stderr.
        print('Frontend update failed: ' + (str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__))
        raise SystemExit(1)
