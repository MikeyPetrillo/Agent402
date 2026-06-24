# Speech-to-Text

Two tiers of audio transcription, paywalled via x402. Provide a URL to an audio file, get back the transcript with language detection and duration. The operator's `OPENAI_API_KEY` handles upstream auth.

## Tiers

| Endpoint | Price | Model | Max duration |
|---|---|---|---|
| `POST /api/transcribe` | $0.03 | `gpt-4o-mini-transcribe` | 5 min |
| `POST /api/transcribe-pro` | $0.10 | `gpt-4o-transcribe` | 10 min |

Both tiers are **wallet-only** — every call burns real upstream transcription credit. See [[Security Model]].

## Supported audio formats

mp3, mp4, mpeg, mpga, m4a, wav, ogg, flac, webm (max 25 MB)

## Request / Response

```json
// Request
{ "url": "https://example.com/audio.mp3", "language": "en" }

// Response
{ "model": "gpt-4o-mini-transcribe", "provider": "openai",
  "text": "Hello, this is a sample transcription.",
  "language": "en", "duration": 3.5 }
```

Only `url` is required. `language` (ISO-639-1 code) is optional but improves accuracy.

## See also

- [[Text-to-Speech|TTS]] — the reverse: text to audio
- [[LLM Proxy Gateway|LLM-Proxy]] — text inference
- [[Paying with x402]] — the USDC payment flow
