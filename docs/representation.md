# Phase 0: how to represent the board in Jev's `state`

The open question the plan puts first: what should the board look like when it is sent
to Jev? This is the method, the three candidates, and the results.

## Why this needs measuring

The [jev-1.13 jaggedness notes](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
rule out the obvious approaches and point in a direction, but do not settle it:

- **"Jev is not a calculator"** and does not count reliably. Any representation that
  asks it to count along a row is fighting the model.
- **Numeric representations underperform semantic ones.** It cannot reliably judge
  proximity between numeric values.
- **Irrelevant state acts as a distractor.** More context is not better.
- **Multi-hop indirection reduces accuracy.** Whatever matters should be stated, not
  derived.

Together these suggest pre-digesting the board in code. But "suggest" is not "show",
and the cost of pre-digestion is that code, not the model, starts making the decision.
So all three are measured.

## The three candidates

### A. Per-cell list (`cellList`)

Every cell and its state, spelled out, with no interpretation.

```json
{
  "boardSize": "10 rows by 10 columns, labelled A1 (top-left) to J10",
  "shipsStillAfloat": ["a ship 5 cells long", "a ship 4 cells long"],
  "cells": {
    "A1": "not yet fired at",
    "A2": "fired at, empty water",
    "A3": "fired at, hit a ship that is still afloat"
  }
}
```

Most literal, most verbose. Every spatial relationship must be inferred by the model.

### B. Row strings (`rowStrings`)

A compact grid with a legend.

```json
{
  "legend": { ".": "not yet fired at", "o": "empty water", "X": "hit", "#": "sunk" },
  "columns": "A B C D E F G H I J",
  "grid": ["row 1: . . o X . . . . . .", "row 2: . . . . . . . . . ."]
}
```

Fewest tokens by a wide margin. But locating a cell means counting along a string,
which is exactly what the model is documented to be bad at.

### C. Semantic candidates (`semantic`)

Code does all the geometry and describes each candidate cell in plain language.

```json
{
  "cellsHitButNotYetSunk": ["D3"],
  "candidates": {
    "D4": "directly continues 1 hit in a row above; has room for the longest ship still afloat; is in the open middle of the board",
    "H8": "sits in a gap too small for ships longer than 3 cells; borders empty water; is on the edge of the board"
  }
}
```

No counting, no grid arithmetic, no indirection. The risk is the opposite one: if the
descriptions are good enough, the code has already made most of the decision.

## Method

Full games are an expensive and noisy way to compare representations — a single early
lucky shot moves the final score by more than the representation does. Instead the
harness scores **single decisions on fixed positions**:

1. Let the density baseline play partway into a game, snapshotting at a spread of
   depths (0, 5, 12, 20, 30 and 45 shots) so openings, mid-game chases and endgames are
   all covered.
2. For each position, record the ground truth — which untried cells actually hold a
   ship that is still afloat.
3. Ask every representation the same question about the same position.
4. Score the answer directly.

Because the harness knows where the ships are, no proxy metric is needed:

| Metric | Meaning |
| --- | --- |
| `hit%` | The chosen cell held a live ship. **The honest measure.** |
| `random%` | Hit rate from choosing uniformly among untried cells. The floor. |
| `density%` | Hit rate of the code-optimal pick on the same positions. The ceiling. |
| `top%` | How often the model agreed with the code-optimal pick. |
| `rank` | Mean position of the choice in the density ranking (1 = best). |

Reporting both baselines on the same positions is what makes `hit%` readable. A hit
rate of 30% means nothing alone; against a 12% floor and a 45% ceiling it means a great
deal. Every representation sees identical positions, so the comparison is paired.

Run it with:

```bash
npm run repr -- --positions 24
```

## Results

<!-- RESULTS -->
_Not yet run against the live model._

To fill this in, set `AI_GATEWAY_API_KEY` and run the command above. The output table
and the model version it was produced against go here. Results are only comparable
within a single model version.

## The free tier will not sustain this benchmark

The first live run of this harness lost 21 of 24 positions to
`GatewayRateLimitError: Free tier requests on this model are rate-limited`. The
three surviving samples per representation were meaningless, and presenting them
as a comparison would have been worse than reporting nothing.

The documented limits - 250,000 tokens/sec and 1,200 requests/min, "adjusting
dynamically" - describe the paid service. The free tier is far tighter and the
docs do not state by how much, so no number is claimed here.

Two mitigations are built in, and neither fully solves it:

- `--minIntervalMs` paces requests (default 1500ms). Requests are chained rather
  than timestamp-checked, so parallel callers queue instead of all firing at once.
- A 429 gets its own retries with doubling backoff, on top of the AI SDK's
  `maxRetries`. Only rate limits are waited out; other errors still fail fast.

With pacing the loss rate drops substantially but does not reach zero. A full
Phase 1 benchmark - five strategies over twenty games, roughly 4,000 sequential
calls - needs paid credits. Budget accordingly, and set a Gateway budget first.

At the observed rate of $0.042 per million input tokens with output free, and
roughly 400-6,000 input tokens per call depending on representation, the cost is
small; the constraint is request rate, not money.

## Limits found while building this

Recorded from the docs, not inferred:

- **255 options per Choice.** A 10x10 board has at most 100 untried cells, so `jevPure`
  can offer every legal move in a single question. A larger board could not, and the
  code guards against it rather than discovering it as an API error.
- **64k tokens per request; 32k for state plus the longest question.** The per-cell
  representation is the only one that comes close on a 10x10 board, and it stays well
  inside.
- **Pricing: $0.042 per million input tokens, output free.** Cheap enough that the
  per-cell representation's verbosity is not the reason to reject it.
- **Rate limits: 250,000 tokens/sec and 1,200 requests/min**, described as adjusting
  dynamically. A single game is a few hundred sequential calls, so a self-play batch is
  latency-bound rather than rate-limited.

Not found in the docs, so not claimed: the maximum number of questions per request.
