#!/usr/bin/env python3
"""Exercise publication guards without credentials or external publication."""
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent


class PublicationPolicy(unittest.TestCase):
    def run_app(self, app, trigger, ref="", ref_type="", version="4.2.1"):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "version.properties").write_text(f"APP_VERSION={version}\n")
            marker = root / "published"
            tools = root / "bin"
            tools.mkdir()
            for name in ("ngit", "netlify"):
                stub = tools / name
                stub.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 91\n")
                stub.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{tools}:{os.environ['PATH']}",
                "NGIT_CI_TRIGGER": trigger,
                "NGIT_CI_REF": ref,
                "NGIT_CI_REF_TYPE": ref_type,
                "NGIT_CI_REF_NAME": ref.removeprefix("refs/tags/"),
                "NGIT_CI_INPUTS": str(root / "missing-inputs"),
                "NGIT_CI_SECRETS_DIR": str(root / "missing-secrets"),
            }
            command = (SCRIPTS / "common.sh").read_text() + (SCRIPTS / f"{app}.sh").read_text()
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", command],
                                    cwd=root, env=env, capture_output=True, text=True)
            self.assertFalse(marker.exists(), "An external publisher was invoked")
            return result

    def test_production_requires_push_to_main(self):
        for app in ("netlify", "nsite"):
            for trigger, ref in (("pull_request", ""), ("manual", "refs/heads/main"),
                                 ("push", "refs/heads/stable"), ("push", "refs/tags/v4.2.1")):
                with self.subTest(app=app, trigger=trigger, ref=ref):
                    self.assertNotEqual(self.run_app(app, trigger, ref).returncode, 0)

    def test_manual_release_needs_no_credentials_or_artifacts(self):
        result = self.run_app("release", "manual")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("publication skipped", result.stdout)

    def test_release_rejects_wrong_tag_and_non_tag(self):
        for trigger, ref, ref_type in (("push", "refs/tags/v4.2.0", "tag"),
                                       ("push", "refs/heads/main", "branch"),
                                       ("pull_request", "", "")):
            with self.subTest(trigger=trigger, ref=ref):
                result = self.run_app("release", trigger, ref, ref_type)
                self.assertNotEqual(result.returncode, 0)

    def test_site_fan_in_uses_directory_relative_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = root / "inputs/test/artifacts/web-dist"
            artifact.mkdir(parents=True)
            (artifact / "index.html").write_text("tested bytes")
            (artifact / "_redirects").write_text("/* /index.html 200")
            script = (SCRIPTS / "common.sh").read_text() + "\ncopy_tested_site\n"
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                    cwd=root, env={**os.environ, "NGIT_CI_INPUTS": str(root / "inputs")},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "dist/index.html").read_text(), "tested bytes")
            self.assertTrue((root / "dist/_redirects").is_file())

    def test_release_fetches_exact_tag_and_consumes_signed_directory(self):
        real_git = shutil.which("git")
        for tag_state in ("matching", "missing", "moved"):
            with self.subTest(tag_state=tag_state), tempfile.TemporaryDirectory() as temporary:
                temporary = Path(temporary)
                source = temporary / "source"
                root = temporary / "checkout"
                source.mkdir()
                root.mkdir()
                git_env = {**os.environ, "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
                           "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}

                def git(cwd, *args):
                    return subprocess.check_output([real_git, *args], cwd=cwd, env=git_env,
                                                   stderr=subprocess.DEVNULL, text=True).strip()

                git(source, "init", "-q")
                git(source, "commit", "--allow-empty", "-qm", "allocated")
                allocated = git(source, "rev-parse", "HEAD")
                if tag_state == "moved":
                    git(source, "commit", "--allow-empty", "-qm", "different commit")
                if tag_state != "missing":
                    git(source, "tag", "v4.2.1")
                git(root, "init", "-q")
                git(root, "fetch", "-q", str(source), allocated)
                git(root, "checkout", "-q", "--detach", "FETCH_HEAD")
                (root / "version.properties").write_text("APP_VERSION=4.2.1\n")
                job = root / "inputs/android-sign"
                (job / "artifacts/signed").mkdir(parents=True)
                (job / "artifacts/signed/gitworkshop-android-v4.2.1.apk").write_text("signed APK")
                (job / "outputs").mkdir()
                (job / "outputs/version").write_text("4.2.1\n")
                tools = root / "bin"
                tools.mkdir()
                # Replace only the remote transport with a local fixture; use
                # real Git tag discovery, fetching and peeled-commit checks.
                wrapper = tools / "git"
                wrapper.write_text(f"#!/bin/sh\nif [ \"$1\" = fetch ]; then\n  exec '{real_git}' fetch --no-tags --force '{source}' refs/tags/v4.2.1:refs/tags/v4.2.1\nfi\nexec '{real_git}' \"$@\"\n")
                wrapper.chmod(0o755)
                stub = tools / "ngit"
                stub.write_text("#!/bin/sh\nset -eu\ntest -f release-artifacts/gitworkshop-android-v4.2.1.apk\nprintf '%s\\n' \"$@\" > published-arguments\n")
                stub.chmod(0o755)
                env = {**git_env, "PATH": f"{tools}:{os.environ['PATH']}",
                       "NGIT_CI_INPUTS": str(root / "inputs"), "NGIT_CI_TRIGGER": "push",
                       "NGIT_CI_REF_TYPE": "tag", "NGIT_CI_REF_NAME": "v4.2.1",
                       "NGIT_CI_COMMIT_SHA": allocated, "NGIT_CI_SECRETS_DIR": str(root / "secrets")}
                command = (SCRIPTS / "common.sh").read_text() + (SCRIPTS / "release.sh").read_text()
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", command],
                                        cwd=root, env=env, capture_output=True, text=True)
                if tag_state == "matching":
                    self.assertEqual(result.returncode, 0, result.stderr)
                    arguments = (root / "published-arguments").read_text().splitlines()
                    self.assertEqual(arguments[:3], ["release", "publish", "4.2.1"])
                    self.assertIn("v4.2.1", arguments)
                    self.assertIn(allocated, arguments)
                    self.assertEqual(git(root, "rev-parse", "refs/tags/v4.2.1^{commit}"), allocated)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((root / "published-arguments").exists())

    def test_preview_is_pr_only(self):
        for trigger in ("push", "manual"):
            self.assertNotEqual(self.run_app("preview", trigger).returncode, 0)


if __name__ == "__main__":
    unittest.main()
