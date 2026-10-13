import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('docker_update', Path(__file__).resolve().parents[1] / 'docker/update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


def record(revision):
    return {'revision': revision * 40, 'architecture': 'arm64', 'image_id': 'sha256:' + revision * 64, 'archive': 'abs-frontend-arm64.docker.tar.gz', 'archive_sha256': 'e' * 64}


class FakeDocker:
    def __init__(self):
        self.active, self.failed, self.actions = None, set(), []
        self.existing = False

    def arch(self): return 'arm64'
    def existing_project(self): return self.existing
    def configuration(self, _image): return {}
    def verify_image(self, _record): return None
    def apply(self, candidate):
        self.actions.append(candidate['revision'])
        self.active = candidate
    def health(self, candidate): return self.active == candidate and candidate['revision'] not in self.failed
    def stop(self, _candidate): self.active = None


class UpdaterTests(unittest.TestCase):
    def test_exact_revision_upgrade_and_noop(self):
        with tempfile.TemporaryDirectory() as root:
            home, docker = Path(root), FakeDocker()
            self.assertTrue(update.rollout(home, record('a'), docker))
            self.assertFalse(update.rollout(home, record('a'), docker))
            self.assertTrue(update.rollout(home, record('b'), docker))
            self.assertEqual(json.loads((home / 'current.json').read_text()), record('b'))
            self.assertEqual(json.loads((home / 'previous.json').read_text()), record('a'))
            self.assertEqual(len(docker.actions), 2)

    def test_failed_candidate_restores_retained_image_and_blocks_retry(self):
        with tempfile.TemporaryDirectory() as root:
            home, docker = Path(root), FakeDocker()
            update.rollout(home, record('a'), docker)
            docker.failed.add(record('b')['revision'])
            with self.assertRaisesRegex(RuntimeError, 'retained/restored'):
                update.rollout(home, record('b'), docker)
            self.assertEqual(docker.active, record('a'))
            self.assertEqual(json.loads((home / 'current.json').read_text()), record('a'))
            self.assertTrue((home / 'blocked' / ('b' * 40 + '.json')).is_file())

    def test_bootstrap_refuses_existing_project(self):
        with tempfile.TemporaryDirectory() as root:
            docker = FakeDocker()
            docker.existing = True
            with self.assertRaisesRegex(ValueError, 'Existing dedicated-project'):
                update.rollout(Path(root), record('a'), docker)
            self.assertEqual(docker.actions, [])

    def test_mismatched_platform_and_mutable_image_refs_are_rejected(self):
        self.assertEqual(update.architecture('linux/aarch64'), 'arm64')
        self.assertEqual(update.architecture('linux/x86_64'), 'amd64')
        for platform in ['darwin/arm64', 'linux/armv7', 'linux/s390x']:
            with self.assertRaises(ValueError): update.architecture(platform)
        with self.assertRaises(ValueError): update.validate_record(record('a'), 'amd64')
        candidate = record('a'); candidate['image_id'] = 'abs-frontend:latest'
        with self.assertRaises(ValueError): update.validate_record(candidate, 'arm64')

    def test_checksum_failure_prevents_docker_loading(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / 'archive.tar.gz'; archive.write_bytes(b'corrupt')
            docker = update.Docker(root)
            docker.run = lambda *_args: self.fail('Docker must not run for a corrupt archive')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'): docker.load(archive, record('a'))


if __name__ == '__main__': unittest.main()
