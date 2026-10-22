#!/usr/bin/env python3
"""Prepare models explicitly; ModelScope is the default download source."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.prepare_models import main
if __name__ == "__main__":
    main()
