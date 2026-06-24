# Text-to-Speech

Two tiers of text-to-speech, paywalled via x402. Send text, get back base64-encoded audio. 10 voices, 6 output formats. The operator's `OPENAI_API_KEY` handles upstream auth.

## Tiers

| Endpoint | Price | Model | Quality | Text cap |
|---|---|---|---|---|
| `POST /api/tts` | $0.05 | `tts-1` | Standard (fast) | 2,000 chars |
| `POST /api/tts-hd` | $0.10 | `tts-1-hd` | HD (higher fidelity) | 2,000 chars |

Both tiers are **wallet-only** — every call burns real upstream TTS credit. See [[Security Model]].

## Voices

`alloy` (default), `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`

## Output formats

`mp3` (default), `opus`, `aac`, `flac`, `wav`, `pcm`

## Request / Response

```json
// Request
{ "text": "Hello from Agent402!", "voice": "alloy", "format": "mp3" }

// Response
{ "model": "tts-1", "provider": "openai", "voice": "alloy", "format": "mp3",
  "audio": "<base64-encoded audio>", "chars": 20 }
```

Only `text` is required. `voice` defaults to `alloy`, `format` defaults to `mp3`.

## See also

- [[Speech-to-Text|STT]] — the reverse: audio to text
- [[LLM Proxy Gateway|LLM-Proxy]] — text inference
- [[Paying with x402]] — the USDC payment flow
