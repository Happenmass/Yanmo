"""Build-time smoke check of the Windows embedded API-only interpreter."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import backend.server
import soundfile
from engine.worker import Engine
assert Engine().provider.__class__.__name__ == 'APIOnlyProvider'
assert 'torch' not in sys.modules and 'mlx' not in sys.modules
print('Windows API runtime verified')
