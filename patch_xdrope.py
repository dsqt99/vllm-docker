import sys

path = "/usr/local/lib/python3.12/dist-packages/vllm/model_executor/layers/rotary_embedding/xdrope.py"
try:
    with open(path, "r") as f:
        content = f.read()

    target = "        assert positions.ndim == 2\n        assert key is not None"
    replacement = "        if positions.ndim == 1:\n            positions = positions.unsqueeze(0).repeat(4, 1)\n        assert positions.ndim == 2\n        assert key is not None"

    if target in content:
        content = content.replace(target, replacement)
        with open(path, "w") as f:
            f.write(content)
        print("Successfully patched xdrope.py")
    else:
        print("Warning: Target pattern not found in xdrope.py, skipping.")
except Exception as e:
    print(f"Error patching xdrope: {e}", file=sys.stderr)
    sys.exit(1)
