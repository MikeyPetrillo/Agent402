# agent402-anthropic-tools

Renamed to [`agent402-tool-use`](https://www.npmjs.com/package/agent402-tool-use). This name gets no further releases.

```bash
npm i agent402-tool-use
```

Then import from `"agent402-tool-use"` where you imported from `"agent402-anthropic-tools"`. The API is the same; nothing else changes.

This last release (0.2.3) depends on `agent402-tool-use`, re-exports it and prints a one-time deprecation notice, so an existing install keeps working until it moves.

Part of [Agent402](https://agent402.tools). MIT licensed.
