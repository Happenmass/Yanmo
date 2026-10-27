import contextlib
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import setup_runtime  # noqa: E402


def run_setup(directory, outcomes):
    """outcomes: return codes for successive pip install attempts."""
    runtime, lock = Path(directory, "runtime"), Path(directory, "requirements.lock")
    lock.write_text("torch==2.14.1+cu130 --hash=sha256:00\n")
    calls, results = [], list(outcomes)

    def run(command, **_):
        calls.append(command)
        if command[1:3] == ["-m", "venv"]:
            setup_runtime.venv_python(runtime).parent.mkdir(parents=True)
            setup_runtime.venv_python(runtime).touch()
            return SimpleNamespace(returncode=0)
        return SimpleNamespace(returncode=results.pop(0) if "install" in command else 0)

    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = setup_runtime.main([str(runtime), str(lock)], run)
    return code, calls, [json.loads(line) for line in output.getvalue().splitlines()], runtime


class SetupRuntimeTests(unittest.TestCase):
    def testFallsBackAcrossMirrorsAndMarksCompletionLast(self):
        with TemporaryDirectory() as directory:
            code, calls, events, runtime = run_setup(directory, [1, 0])
            self.assertEqual(code, 0)
            installs = [call for call in calls if "install" in call]
            self.assertEqual([call[call.index("-i") + 1] for call in installs], [setup_runtime.INDEXES[0][0], setup_runtime.INDEXES[1][0]])
            self.assertIn("--require-hashes", installs[0])
            self.assertIn(["cache", "purge"], [call[3:5] for call in calls])
            self.assertTrue((runtime / "lock.sha256").is_file())
            self.assertEqual(events[-1], {"event": "step", "step": "done"})
            # A second run with the same lock does nothing.
            code, calls, _, _ = run_setup(directory, [])
            self.assertEqual((code, calls), (0, []))

    def testAllMirrorsFailingLeavesNoMarker(self):
        with TemporaryDirectory() as directory:
            code, _, events, runtime = run_setup(directory, [1, 1, 1])
            self.assertEqual(code, 1)
            self.assertEqual(events[-1]["event"], "error")
            self.assertFalse((runtime / "lock.sha256").exists())


if __name__ == "__main__":
    unittest.main()
