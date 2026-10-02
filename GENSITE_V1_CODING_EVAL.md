# Gensite v1 coding evaluation

The first developer trial is in `E:\Side Project\gensite-v1-evaluation\REPORT.md`. Its long website request exceeded the client's 240-second deadline while the gateway continued generating for roughly 390 seconds. The project built and passed the local logic checks, but the trial also found missed tool failures and keyboard/accessibility defects.

## Repeatable routing comparison

Run the same coding tasks through `gensite-v1` and each candidate public model with the same prompt, tools, client deadline, and output budget. Use at least 20 runs per task/model before changing `GENSITE_TIER_CODER`; one successful build is not enough evidence. Include a small bug fix, a medium feature, and a multi-page website. For every run, record:

| Measure | Source |
| --- | --- |
| Time to first output, total duration, output tokens per second | `chat.stream_ok` logs (`first_output_ms`, `latency_ms`, `output_tokens_per_s`) |
| Client timeouts, cancellations, provider failures | Client result and `chat.stream_cancelled` / `chat.stream_failed` logs |
| Serving model and tier | `gensite_model`, `gensite_tier` log fields |
| Credits and completion | Usage event and `chat.stream_ok` log |
| Correctness | Build, tests, and direct check of the requested behavior |
| Web quality | Keyboard-only navigation, focus visibility, text contrast, mobile width, and key user flows |

Treat a timed-out or cancelled answer as a failure even if a server log later reports generated output. Route changes should improve completed-task rate within the client deadline without a material regression in correctness or cost. Keep the prior tier list available through `GENSITE_TIER_CODER` so a change can be rolled back without code deployment.

On `/v1/chat/completions`, the gateway now stops the upstream request when a streaming client disconnects. The provider sends no final usage for a stopped request, but still bills Gensite for what it processed, so the turn is settled on an estimate: the prompt at about 4 characters per token, with no cache discount, plus the output the gateway received, capped at the output limit. The `chat.stream_cancelled` log records `estimated_input_tokens`, `estimated_output_tokens` and `credits_charged`. Compare these with the provider's usage for the same requests to check the estimate. `/v1/messages`, `/v1/responses` and dashboard chat still let a disconnected turn finish and bill its exact usage.
