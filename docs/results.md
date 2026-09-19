# Phase 1 benchmark: how well does Jev play Battleship?

Run on 2026-09-19. 60 games per strategy, `mixed` layouts, direct TypeSafe
transport, model **`jev-1.13.0`** as reported by the API. Every strategy played
the same 60 layouts, so all comparisons below are paired.

```
strategy                  games  mean  median    sd  min  max  acc  ms/shot  tok/game     cost
------------------------  -----  ----  ------  ----  ---  ---  ---  -------  --------  -------
Jev hybrid (top 16)          60  46.0    47.0   9.6   26   71  37%      339     54365  $0.1198
Probability density          60  48.3    49.0  11.6   25   69  35%       <1         -        -
Hunt / Target                60  51.9    52.0   7.6   33   64  33%       <1         -        -
Jev pure (Per-cell list)     60  85.5    88.5  12.2   48  100  20%      348    297315  $0.6452
Random                       60  95.3    97.0   5.3   69  100  18%       <1         -        -
```

Lower is better. 17 shots is perfect; 100 is the worst possible.

## The headline: the model needs code to narrow the field

| comparison | difference | 95% CI | p | verdict |
| --- | --- | --- | --- | --- |
| jevHybrid − density | −2.22 | [−5.11, 0.68] | 0.13 | **not distinguishable** |
| jevHybrid − huntTarget | −5.90 | [−8.96, −2.84] | 0.00015 | significant |
| density − huntTarget | −3.68 | [−7.47, 0.10] | 0.056 | not distinguishable |
| jevPure − random | −9.78 | [−12.76, −6.80] | 1.3e−10 | significant |
| jevPure − huntTarget | **+33.57** | [30.08, 37.05] | <1e−15 | significant |

### jevPure: choosing from ~90 cells is close to guessing

This is the strongest result in the run, and it is a negative one. Given the raw
board and every untried cell as an option, Jev needs **85.5 shots** against
random's 95.3. The 9.8-shot gap is real (p = 1.3e−10), so it is reading the
board rather than guessing outright - but it loses to `huntTarget`, a fifty-line
heuristic, by **33.6 shots**, and lost on 59 of 60 layouts.

Two documented traits explain it. Every option is labelled identically, so all
the signal sits in a 3,000-character state the model must parse unaided; and
probabilities come back rounded to two decimals, so spread across ~90 options
most of the distribution collapses to zero. It cost **$0.65** to finish barely
ahead of random.

### jevHybrid: as good as the code baseline, not better

With code ranking the top 16 and describing each in words, Jev reaches **46.0
shots** - comfortably past `huntTarget` (p = 0.00015) and nominally ahead of
`density`. But the density comparison is **not significant**: a 2.2-shot
difference with a CI spanning zero, winning 31 of 60 layouts, which is a
coin flip.

So the honest reading is that `jevHybrid` **matches** the best code-only player
rather than beating it. At 60 games this run could detect a 4.7-shot difference;
the observed gap is half that. Settling it needs roughly 260 games per strategy,
about 2.5 hours and $0.80 on this transport.

## What this says about the model

Jev is doing real work: `jevHybrid` beats a competent heuristic decisively, and
even `jevPure` clears random. But its contribution shows up **only when code has
already reduced the problem to a short list of described options**. Asked to
find a ship on a raw board, it is far worse than a simple hand-written rule.

That is consistent with the documented jaggedness: it is not a calculator, it
loses accuracy as irrelevant state grows, and it does better on semantic
descriptions than on positions it has to derive. The design that wins here is the
one that plays to that - code does the geometry and the counting, the model
judges between candidates.

## Caveats

- **One model version.** Results hold for `jev-1.13.0` only.
- **One layout family.** `mixed`; the ranking between code baselines is known to
  invert across families (see `representation.md`).
- **Accuracy is not the objective.** It is reported for context; shots to sink
  the fleet is the benchmark.
- `jevHybrid`'s score belongs to the code and the model together. Only the
  comparison against `density` isolates the model's contribution, and that
  comparison is currently inconclusive.

## Reproducing

```bash
npm run bench -- --transport direct --layouts mixed --games 60 \
  --strategies random,huntTarget,density,jevPure,jevHybrid --seed 1000
```

Each call's `generationId` is in the JSON output for cross-checking against the
TypeSafe request logs.
