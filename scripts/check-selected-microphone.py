"""Record briefly with an explicitly chosen microphone, then with the system default.

Run on a Mac with microphone access: python3 scripts/check-selected-microphone.py
BRIDGE DEVICE_UID. Only duration and pass/fail are printed; audio stays in memory.
"""
import argparse
import base64
import json
import subprocess
import time


def request(bridge, command, args):
    message = {"id": command, "command": command, "args": args}
    bridge.stdin.write(json.dumps(message).encode() + b"\n")
    bridge.stdin.flush()
    for line in bridge.stdout:
        reply = json.loads(line)
        if reply.get("id") == command:
            if not reply["ok"]:
                raise RuntimeError(reply["error"])
            return reply["result"]
    raise RuntimeError("Bridge exited before replying")


def check_recording(executable, device):
    with subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as bridge:
        try:
            request(bridge, "record.start", {"device": device})
            time.sleep(1.5)
            recording = request(bridge, "record.finish", {})
            wav = base64.b64decode(recording["audioBase64"], validate=True)
            if wav[:4] != b"RIFF" or wav[8:12] != b"WAVE" or recording["seconds"] < 0.5:
                raise RuntimeError("Incomplete in-memory recording")
            print(f"PASS {device or 'system default'}: {recording['seconds']:.2f} s")
        finally:
            bridge.stdin.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bridge")
    parser.add_argument("device_uid")
    args = parser.parse_args()
    for device in (args.device_uid, ""):
        check_recording(args.bridge, device)
