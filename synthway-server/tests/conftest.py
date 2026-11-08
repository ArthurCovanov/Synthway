"""Test setup: run the server code from src/, so that no test can make a sound."""
import os
import sys
from pathlib import Path

# The server module never loads synthway.dll / libsynthway.so in tests: its core
# is replaced with fakes. Only test_render.py loads the real library, and only
# for offline rendering (no audio device).
os.environ["SYNTHWAY_CORE_LIB"] = str(Path(__file__).parent / "no-native-library-in-tests")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
