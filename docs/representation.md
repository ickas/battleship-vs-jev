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

Run on 2026-09-19, 18 positions requested, `--minIntervalMs 3000`, model id
`typesafe-ai/jev`.

```
representation        n  hit%  random%  density%  top%  rank  conf   tok
-------------------  --  ----  -------  --------  ----  ----  ----  ----
Semantic candidates  12  50.0     11.4      61.1  33.3  36.5  0.50  4842
Row strings          12  41.7     11.4      61.1  25.0  52.1  0.34  2587
Per-cell list        14  35.7     11.4      61.1  42.9  27.9  0.34  3476
```

### What this does show

**Jev is genuinely playing Battleship.** Every representation beats the random
floor by a wide margin, and that result survives the small sample:

| Representation | hits | binomial p vs random |
| --- | --- | --- |
| Semantic candidates | 6/12 | 0.0011 |
| Row strings | 5/12 | 0.0076 |
| Per-cell list | 5/14 | 0.0159 |

Picking uniformly among untried cells lands on a live ship 11.4% of the time.
Jev lands on one three to four times as often. It is reading the board.

**It does not reach the code-optimal pick.** The density baseline scores 61.1%
on the same positions. Only the per-cell list is significantly below that
(p = 0.049); the other two are not distinguishable from the ceiling either way,
which is a statement about the sample size, not about the model.

### What this does not show

**It does not identify a best representation.** The apparent ranking is noise.
No pair is distinguishable:

| Comparison | Fisher exact, two-sided |
| --- | --- |
| Semantic vs row strings | p = 1.000 |
| Semantic vs per-cell list | p = 0.692 |
| Row strings vs per-cell list | p = 1.000 |

The 95% confidence intervals overlap almost completely: semantic
[25.4%, 74.6%], row strings [19.3%, 68.0%], per-cell list [16.3%, 61.2%].
Separating a true 50% from a true 36% at 80% power would need roughly **187
positions per representation**. This run scored 12 to 14.

The secondary columns disagree with the primary one, which is what noise looks
like: the per-cell list has the *worst* hit rate but the *best* mean density
rank (27.9) and the highest agreement with the code-optimal pick (42.9%). With
this sample none of that is interpretable.

**The plan says to pick the representation based on data. The data does not
support a pick, so no pick is claimed here.** The defaults in the code are
chosen on reasoning rather than evidence, and are labelled as such:

- `jevPure` defaults to `cellList`, because it is the only representation that
  contains no code-computed judgement. That is a decision about what the
  benchmark *measures*, not about what scores best.
- `jevHybrid` defaults to `semantic`, because its whole design is that code
  describes a shortlist. Using anything else would make the strategy incoherent.

### Caveats on this specific run

- **The comparison is not fully paired.** Rate limiting cost different positions
  for each representation (14, 12 and 12 scored of 18), so they did not all
  answer the same set. The harness reports positions scored per representation
  for exactly this reason.
- **The latency column is unusable and has been omitted above.** This run
  predates the fix that excludes client-side rate-limit backoff from
  `latencyMs`, so the figures in the raw output (12.4s to 23.5s) are mostly
  sleep, not Gateway round-trip time. Re-run to get real latency.
- 16 of 54 calls were lost to rate limits, and one to a client-side timeout on
  the semantic representation, which sends the largest state.

### What would settle it

Roughly 200 positions per representation, which is about 600 calls. That needs
paid Gateway credits; see below. Until then the representation question is open,
and the code says so rather than implying it was answered.

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
