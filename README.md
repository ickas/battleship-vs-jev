# Battleship vs. Jev

A Battleship benchmark for **Jev**, TypeSafe's "System One" model, reached through
Vercel AI Gateway.

Jev is not a generative LLM. You send it a `state` plus typed questions and it returns
structured answers with probability distributions. This project measures how well it
plays Battleship, and shows *how* it decides, by rendering its own per-cell
probabilities as a live heatmap.

The goal is an honest benchmark first. A strong player is secondary — the code-only
baselines are here precisely so the model's performance can be read against something.

## What it measures

Five strategies play the same seeded fleet layouts:

| Strategy | Model calls | What it does |
| --- | --- | --- |
| `random` | no | Uniform random among untried cells. The floor. |
| `huntTarget` | no | Classic parity search, then works outwards from hits. |
| `density` | no | Counts valid remaining-ship placements per cell. The strongest code player. |
| `jevPure` | yes | One Choice over every untried cell, with raw board state. Code supplies only the rules. |
| `jevHybrid` | yes | Code ranks the top K cells and describes them; Jev only compares those. |

The headline number is **mean shots to sink the fleet** — lower is better. 17 is
perfect, 100 is the worst possible.

## Requirements

- Node 20.12 or later, for `process.loadEnvFile` (developed on Node 26)
- An `AI_GATEWAY_API_KEY` from [Vercel AI Gateway](https://vercel.com/docs/ai-gateway),
  for the Jev strategies only. Everything else runs without one.

```bash
npm install
cp .env.example .env   # then paste your key into .env
```

`.env.local` is read first if present, then `.env`. Variables already exported in the
environment always win over both.

Note the free tier rate-limits this model hard enough to fail a long run. All three
runners pace requests (`--minIntervalMs`, default 1500) and retry a 429 with backoff.
See [docs/representation.md](docs/representation.md#the-free-tier-will-not-sustain-this-benchmark).

## Running it

```bash
npm test                 # 180 unit tests, no network
npm start                # web UI at http://localhost:3000
npm run bench -- --games 20
npm run repr -- --positions 24
npm run selfplay -- --games 50
```

Every command takes `--mock` to run without an API key. Mock answers come from the
same code-side density the baselines use, so they are **never benchmark results** —
the output says so, and every mock response is tagged `mock-not-a-model`.

### Benchmark (Phase 1)

```bash
npm run bench -- --games 20 --strategies density,jevHybrid --representation semantic
```

All strategies face identical layouts, so the comparison is paired. If a strategy
loses games to errors the report says so explicitly and the table is flagged as not
paired, rather than quietly comparing means over different layout sets. Results are
written to `results/` as JSON and CSV.

```
strategy             games  mean  median    sd  min  max  acc  ms/shot  tok/game
-------------------  -----  ----  ------  ----  ---  ---  ---  -------  --------
Probability density      6  48.0    47.0   5.8   42   58  35%       <1         -
Hunt / Target            6  51.7    56.5  13.1   33   66  33%       <1         -
Random                   6  95.5    99.0   7.8   80  100  18%       <1         -
```

### Representation comparison (Phase 0)

```bash
npm run repr -- --positions 24
```

Compares three ways of describing the board to Jev on a fixed set of mid-game
positions. See [docs/representation.md](docs/representation.md) for the method and
results.

### Self-play (Phase 2)

```bash
npm run selfplay -- --games 50
```

Two Jev players, identical except that one uses a history of its opponent and one
does not. Reports the win rate and whether the difference is distinguishable from
noise.

## Architecture

```
src/
  engine/      board, fleet, placement validation, shot resolution, density, game loop
  jev/         JevClient - the ONLY place that talks to Jev
    gateway      AI SDK experimental_evaluate through AI Gateway
    mock         stand-in for tests and UI work without a key
    representations  the three board encodings compared in Phase 0
  strategies/  shared Strategy interface: nextShot(view)
  selfplay/    Phase 2: opponent history, Jev-driven placement, match loop
  metrics/     per-shot and per-game aggregation, comparison table, CSV
  bench/       headless runners for all three phases
  server/      holds the API key; the browser never sees it
  ui/          board view, live heatmap, metrics panel
```

Two rules shape the whole design:

**All arithmetic lives in code.** Jev is documented as unreliable at counting, numeric
precision and date comparison. So the engine does every rule check, every placement
count and every probability calculation. Jev is only ever asked to judge between
options that code has already established are legal.

**Every Jev call goes through `JevClient`,** which logs the state, the questions, the
response, latency, tokens, confidence and the resolved model version. Nothing else in
the codebase imports the AI SDK.

## Verified API facts

Checked against the docs rather than from memory, on 2026-09-19:

| Fact | Value | Source |
| --- | --- | --- |
| Model id | `typesafe-ai/jev` | [Vercel changelog](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway) |
| Version reported by the Gateway | none — see below | observed |
| Minimum AI SDK | 7.0.105 | Vercel changelog |
| Question types | `boolean`, `choice`, `score` | [Evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation) |
| Max Choice options | 255 | [Choice](https://docs.typesafe.ai/primitives/choice.md) |
| Request budget | 64k tokens; state + longest question 32k | [Models](https://docs.typesafe.ai/models.md) |
| Pricing | $0.042 per million input tokens; output free | [Models](https://docs.typesafe.ai/models.md) |
| Rate limits | 250,000 tokens/sec, 1,200 requests/min, adjusted dynamically | [Models](https://docs.typesafe.ai/models.md) |
| Confidence | `result.providerMetadata.typesafe.confidence` | Vercel changelog |

Two places where the shipped SDK types are stricter than the prose docs, and the code
follows the types:

- `probabilities` is **optional** on choice and score answers. Nothing here assumes a
  heatmap is available: when it is absent the UI shows the code-side density instead
  and says so, rather than silently presenting code output as the model's belief.
- `rounding` is `{ probabilityDecimals?, scoreDecimals? }`, not a number. Live responses
  report `{ probabilityDecimals: 2, scoreDecimals: 2 }`, so the heatmap's real
  granularity is 0.01.

Evaluation is available through the AI SDK only — not on the OpenAI-, Anthropic- or
Cohere-compatible Gateway endpoints.

### The model version cannot be recorded, and this matters

The plan asks for the Jev version in every benchmark result, since results are not
comparable across versions. **Through the Gateway, that is not currently possible.**
Probed on 2026-09-19 with `npx tsx scripts/probe-model-version.mts`:

- `response.modelId` returns `typesafe-ai/jev` — the alias that was requested, not a
  resolved build.
- `providerMetadata.gateway.routing.canonicalSlug` is also `typesafe-ai/jev`.
- Pinning a version fails: `typesafe-ai/jev-1.13.0`, `typesafe-ai/jev-1.13` and
  `typesafe-ai/jev-latest` all return `Model not found`.

TypeSafe's own docs say the alias points at `jev-1.13.0`, but nothing in the Gateway
response confirms which build answered a given call. So results here record the alias
and the date, and **a silent model update would be invisible**. Every result file also
stores the Gateway `generationId`, which is the only reliable way to tie a benchmark
row back to a specific call in the Gateway logs.

Confidence is reported for `choice` and `score` only. A boolean-only request returns
`confidence: {}`.

### What each strategy actually measures

`jevPure` defaults to the `cellList` representation — raw per-cell status, no
interpretation — so its score reflects the model deciding from board state alone.
Running it with `--representation semantic` is supported and is how Phase 0 compares
encodings, but that representation feeds the model code-computed judgements such as
"continues a line of two hits". A run configured that way is a representation
experiment, not a measure of the model playing unaided.

`jevHybrid` is explicitly a collaboration: the density code picks the shortlist, so
its score belongs to the pair, not to the model. It is the interesting number for
"can Jev add anything on top of good code?", and `density` is the baseline it has to
beat to claim it does.

The UI labels every heatmap with its source, so a code-side fallback is never read as
Jev's own probabilities.

## Honesty notes

- Latency reported everywhere is **end to end through the Gateway**, measured by the
  client. It includes Gateway overhead and is not a measure of Jev alone.
- Results are only comparable within a single model version. Every result file records
  the version that answered.
- The self-play history test refuses to claim an effect below 10 decided games, or
  when the win rate sits within noise of a coin flip.
- No cost or limit in this repo was invented. Anything not in the table above is not
  claimed.

## Licence

MIT
