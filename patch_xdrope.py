import sys
import os

path = "/usr/local/lib/python3.12/dist-packages/vllm/model_executor/layers/rotary_embedding/xdrope.py"
mrope_path = "/usr/local/lib/python3.12/dist-packages/vllm/model_executor/layers/rotary_embedding/mrope.py"

try:
    if os.path.exists(path):
        print(f"Targeting legacy xdrope file: {path}")
        with open(path, "r") as f:
            content = f.read()

        target = "        assert positions.ndim == 2\n        assert key is not None"
        replacement = "        if positions.ndim == 1:\n            positions = positions.unsqueeze(0).repeat(4, 1)\n        assert positions.ndim == 2\n        assert key is not None"

        if target in content:
            content = content.replace(target, replacement)
            with open(path, "w") as f:
                f.write(content)
            print("Successfully patched xdrope.py")
        elif "positions.unsqueeze(0).repeat(4, 1)" in content:
            print("Notice: xdrope.py is already patched.")
        else:
            print("Warning: Target pattern not found in xdrope.py, skipping.")
    elif os.path.exists(mrope_path):
        print("Notice: vLLM nightly uses mrope.py with native (ndim == 1 or ndim == 2) support. No legacy xdrope patch needed.")
        sys.exit(0)
    else:
        print("Notice: rotary_embedding module found without xdrope.py. Upstream vLLM handles position embedding natively.")
        sys.exit(0)
except Exception as e:
    print(f"Error checking/patching xdrope: {e}", file=sys.stderr)
    sys.exit(1)
