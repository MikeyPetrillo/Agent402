# agent402-langchain

Renamed to [`agent402-structured-tools`](https://pypi.org/project/agent402-structured-tools/). This name gets no further releases.

```bash
pip install "agent402-structured-tools[langchain]"
```

Then import `agent402_structured_tools` where you imported `agent402_langchain`. The API is the same; nothing else changes.

This last release (0.1.7) depends on `agent402-structured-tools`, re-exports it and emits a `DeprecationWarning` once on import, so an existing install keeps working until it moves.

Part of [Agent402](https://agent402.tools). MIT licensed.
