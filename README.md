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
| `jevHybrid` | yes | Code ranks the top K cells (default 16) and describes them; Jev compares those. |

The headline number is **mean shots to sink the fleet** — lower is better. 17 is
perfect, 100 is the worst possible.

## Requirements

- Node 20.12 or later, for `process.loadEnvFile` (developed on Node 26)
- A key for **one of the two transports** below, for the Jev strategies only.
  Everything else runs without either.

### Two ways to reach Jev

| | `--transport direct` | `--transport gateway` (default) |
| --- | --- | --- |
| Route | TypeSafe API, `@typesafe-ai/sdk` | Vercel AI Gateway, AI SDK `experimental_evaluate` |
| Key | `TYPESAFE_API_KEY` | `AI_GATEWAY_API_KEY` |
| Reports the model that answered | **yes** (`result.model`) | no, only the alias requested |
| Version can be pinned | **yes**, via `--model` | no, pinned ids return "Model not found" |
| `probabilities` / `confidence` | always present | optional in the SDK's types |
| Free-tier rate limit | not the Gateway's | severe; see below |

**Use `direct` for benchmarking.** It is the only transport that can record which
model version produced a result, which the plan requires and the Gateway cannot
supply. `gateway` is kept because the plan's premise is Gateway access, and running
both is how Gateway overhead gets measured.

```bash
npm run repr -- --transport direct --positions 200
npm run bench -- --transport direct --games 20 --model jev-1.13.0
npx tsx scripts/list-models.mts   # which versions this account can pin
```

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

Every command takes `--transport direct|gateway|mock`; `--mock` is shorthand for the
last. Mock answers come from the
same code-side density the baselines use, so they are **never benchmark results** —
the output says so, and every mock response is tagged `mock-not-a-model`.

### Benchmark (Phase 1)

```bash
npm run bench -- --games 20 --strategies density,jevHybrid --representation semantic
```

```bash
npm run bench -- --layouts mixed --transport direct --games 60
```

**The layout family changes the answer**, so it is a first-class option
(`--layouts random|edge|centre|adversarial|mixed`, default `mixed`). Over 200
layouts per family, the code baselines invert:

| layout family | density | huntTarget |
| --- | --- | --- |
| random | 43.4 | 51.8 |
| edge | 52.3 | 50.1 |
| adversarial | 53.0 | 49.8 |
| mixed | 48.6 | 48.7 |

`density` assumes a uniform placement prior, so uniform-random layouts are the
one case it is built for. Benchmarking only on those flatters the very baseline
the model is measured against. Every result records its layout family; results
from different families are not comparable.

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

**First result (2026-09-19):** all three representations beat the random floor by a
wide margin — Jev is reading the board, not guessing — but none of them is
distinguishable from the others at this sample size, and none reaches the code-side
density baseline. The representation question is therefore still open; the defaults in
the code are chosen on reasoning, not on evidence, and are labelled that way.

| | hit% | vs random floor (11.4%) | vs each other |
| --- | --- | --- | --- |
| Semantic candidates | 50.0% (6/12) | p = 0.0011 | not distinguishable |
| Row strings | 41.7% (5/12) | p = 0.0076 | not distinguishable |
| Per-cell list | 35.7% (5/14) | p = 0.0159 | not distinguishable |

Separating these would need roughly 200 positions each, which the free tier cannot
supply.

### Self-play (Phase 2)

```bash
npm run selfplay -- --games 50
```

Two Jev players, identical except that one uses a history of its opponent and one
does not. Reports the win rate and whether the difference is distinguishable from
noise.

## The web UI

```bash
npm start   # http://localhost:3000
```

Settings live in the query string, so a link reproduces a run exactly:

```
http://localhost:3000/?strategy=jevHybrid&representation=semantic&layout=adversarial&seed=77
```

| parameter | values |
| --- | --- |
| `strategy` | `random`, `huntTarget`, `density`, `jevPure`, `jevHybrid` |
| `representation` | `cellList`, `rowStrings`, `semantic` (dropped for code-only strategies) |
| `layout` | `random`, `edge`, `centre`, `adversarial`, `manual` |
| `seed` | any integer; the same seed gives the same fleet |
| `palette` | `sequential` (default), `traffic` |

Changing a control rewrites the URL in place, and "Copy link" puts it on the
clipboard.

**Mock mode is deliberately not one of these.** It replaces the model with
code-side density, which changes what the numbers *mean* rather than what is
being measured, so it is a server-side switch:

```bash
JEV_MOCK=1 npm start
```

The server ignores a `mock` field in a request body, so no page, link or stray
click can turn it on, and the UI shows a banner whenever it is active. Use it
for demos and UI work without spending calls; never for results.

| `JEV_MOCK` | result |
| --- | --- |
| unset (the default), empty | **off** — the real model |
| `0`, `false`, `no` | off |
| `1`, `true`, `yes` (any case) | **on** — code-side density |
| anything else | off |

It fails safe in one direction only: anything unrecognised leaves the real model
in place, so a typo costs an API call rather than the validity of a run.
Surrounding whitespace and quotes in `.env` are ignored.

## Architecture

```
src/
  engine/      board, fleet, placement validation, shot resolution, density, game loop
  jev/         JevClient - the ONLY place that talks to Jev
    gateway      AI SDK experimental_evaluate through Vercel AI Gateway
    direct       TypeSafe API via @typesafe-ai/sdk; reports the real model version
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
response, latency, tokens, confidence, the model id the Gateway reported and the
Gateway's own generation id and cost. Nothing on the benchmark path imports the AI SDK
except `src/jev/gateway.ts`; the one exception is `scripts/probe-model-version.mts`, a
diagnostic that inspects raw response headers the client deliberately does not expose.

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

### The model version cannot be recorded *through the Gateway*, and this matters

The plan asks for the Jev version in every benchmark result, since results are not
comparable across versions. **Through the Gateway, that is not currently possible.**
Probed on 2026-09-19 with `npx tsx scripts/probe-model-version.mts`:

- `response.modelId` returns `typesafe-ai/jev` — the alias that was requested, not a
  resolved build.
- `providerMetadata.gateway.routing.canonicalSlug` is also `typesafe-ai/jev`.
- Pinning a version fails: `typesafe-ai/jev-1.13.0`, `typesafe-ai/jev-1.13` and
  `typesafe-ai/jev-latest` all return `Model not found`.

TypeSafe's own docs say the alias points at `jev-1.13.0`, but nothing in the Gateway
response confirms which build answered a given call. **The direct transport does not
have this problem** — `SystemOneResult.model` names the model that answered, and
`--model` pins a version — which is why it is the right choice for a benchmark. So results here record the alias
and the date, and **a silent model update would be invisible**. Every result file also
stores the Gateway `generationId` for each call — in the JSON, and in the CSV's
`generationIds` column — which is the only reliable way to tie a benchmark row back to
a specific call in the Gateway logs.

Confidence is reported for `choice` and `score` only. A boolean-only request returns
`confidence: {}`.

### What each strategy actually measures

`jevPure` defaults to the `cellList` representation — raw per-cell status, no
interpretation — so its score reflects the model deciding from board state alone.
Running it with `--representation semantic` is supported and is how Phase 0 compares
encodings, but that representation feeds the model code-computed judgements such as
"continues a line of two hits". A run configured that way is a representation
experiment, not a measure of the model playing unaided.

The shortlist size matters more than it looks. When a ship is hit but not sunk, the
cells that could complete it form a frontier of up to `longest - 1` cells in each of
four directions, and the measured mean is 9.9 cells
(`npx tsx scripts/measure-frontier-coverage.mts`):

| topK | frontier cells offered | positions with the whole frontier offered |
| --- | --- | --- |
| 4 | 37.7% | 15.5% |
| 8 | 65.1% | 37.5% |
| **16** | **90.3%** | **70.8%** |
| 24 | 96.6% | 82.8% |

At topK 8 the code hides a third of the plausible cells, and offers the complete
frontier only 37% of the time - so it, not the model, is making most of the decision.
The default is therefore 16. Measured scores at 4, 8, 16 and 24 are *not*
distinguishable at small sample sizes, so this is a choice about not hobbling the
model rather than a demonstrated gain; larger values cost proportionally more tokens.

`jevHybrid` is explicitly a collaboration: the density code picks the shortlist, so
its score belongs to the pair, not to the model. It is the interesting number for
"can Jev add anything on top of good code?", and `density` is the baseline it has to
beat to claim it does.

The UI labels every heatmap with its source, so a code-side fallback is never read as
Jev's own probabilities.

### Reading the heatmap

The overlay covers only the cells the model was actually asked about, which for
`jevHybrid` is exactly the shortlist (16 by default) and for `jevPure` is every
untried cell. The scale beneath the board says how many cells were rated and how
strong the strongest was.

Probability is a magnitude, so the default ramp is **one hue in six discrete steps**,
dark to light. It is ordered by lightness, which keeps it readable in greyscale and
with any colour vision, and discrete bands separate cells far better than a
continuous fade, where low values vanish. Validated against this surface with the
data-viz palette validator.

A `traffic` palette (green to red) is available via the selector or the URL, because
the convention reads as an instruction rather than a quantity. It is **not** the
default: its lightness is not ordered, it spans 117 degrees of hue, and green-to-red
is the hardest pairing for the ~8% of men with red-green colour blindness. Its
high-probability red also sits close to the colour used for a hit.

`jevPure` reveals a limitation worth knowing: Jev rounds probabilities to two
decimals, so spread across ~90 options most cells round to zero and only a handful
ever carry a value. `jevHybrid`'s shortlist concentrates the distribution, so its
heatmap is far more informative.

## Honesty notes

- Latency reported everywhere is **end to end through the Gateway**, measured by the
  client. It includes Gateway overhead and is not a measure of Jev alone. It covers the
  successful attempt only: time spent sleeping between rate-limit retries is reported
  separately as `retryWaitMs`, so backoff never inflates a benchmark figure.
- Costs prefer the figure the transport reports. The Gateway returns a per-call
  `marketCost`; the TypeSafe API returns token usage but no cost, so on the direct
  transport cost is computed from the published rate and labelled **est.** everywhere
  it appears. The rate lives in one place, `src/jev/pricing.ts`, with its source and
  the date it was confirmed, and a test asserts it still reproduces a cost the Gateway
  actually billed.
- Results are only comparable within a single model version. Every result file records
  the version that answered.
- The self-play history test refuses to claim an effect below 10 decided games, or
  when the win rate sits within noise of a coin flip.
- No cost or limit in this repo was invented. Anything not in the table above is not
  claimed.

## Licence

MIT
