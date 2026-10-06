# Phase 2 benchmark: Jev against Cloudflare's Clef

Run on 2026-10-06. 60 games per player, `mixed` layouts, seed 1000, every player
on the same 60 layouts. Pairing is verified rather than assumed: the fleets are
byte-identical layout by layout against the Phase 1 run, so every comparison
below, including those against the September Jev and baseline numbers, is paired.

All three models were reached through the **OpenRouter Decisions API**. That is
deliberate. Reaching Jev through the Vercel Gateway and Clef through Workers AI
would have measured two networks, two queues and two regions as well as two
models, with no way to attribute a difference afterwards. One endpoint leaves the
model as the only thing that varies.

```
player                 n   mean  median     sd  min  max      cost
----------------------------------------------------------------------
hybrid/jev            60   46.0    47.0    9.6   26   71   $0.1198*
density/code          60   48.3    49.0   11.6   25   69          -
hybrid/clef           60   48.6    48.0   13.0   24   99    $0.6040
hybrid/clef-flash     60   49.9    48.0    7.8   31   71    $0.2331
hunt/code             60   51.9    52.0    7.6   33   64          -
pure/clef             60   76.2    80.5   16.8   31  100    $2.9463
pure/jev              60   85.5    88.5   12.2   48  100   $0.6452*
pure/clef-flash       60   87.0    92.0   13.2   44  100    $1.2096
random/code           60   95.3    97.0    5.3   69  100          -
```

Lower is better. 17 shots is perfect; 100 is the worst possible.
`*` estimated from a published rate; the Clef figures are billed.

## The headline: Clef reads a raw board better, and it changes nothing

| comparison | difference | 95% CI | p | verdict |
| --- | --- | --- | --- | --- |
| pure/clef − pure/jev | −9.3 | [−14.0, −4.6] | 0.0002 | **significant** |
| pure/clef − pure/clef-flash | −10.8 | [−15.4, −6.2] | 1.5e−5 | **significant** |
| pure/jev − pure/clef-flash | −1.5 | [−5.6, 2.7] | 0.48 | tie |
| hybrid/jev − density | −2.2 | [−5.2, 0.7] | 0.14 | tie |
| hybrid/clef − density | −0.3 | [−3.9, 3.2] | 0.85 | tie |
| hybrid/clef-flash − density | −1.6 | [−5.4, 2.2] | 0.39 | tie |
| hybrid/jev − hybrid/clef | −2.6 | [−6.1, 1.0] | 0.16 | tie |
| hybrid/clef − hybrid/clef-flash | −1.3 | [−5.1, 2.5] | 0.51 | tie |
| hybrid/jev − hybrid/clef-flash | −3.9 | [−7.3, −0.4] | 0.030 | nominal only |

36 pairs were tested, so the Bonferroni-corrected threshold is **0.0014**. The
last row clears the uncorrected 5% bar and nothing else; it is not a finding.

Clef is genuinely better than both other models at choosing from a raw board with
~90 options. That result survives correction comfortably and is the only place
any model separates from any other.

It does not matter. At 76.2 shots, Clef's pure player is still **28 shots worse
than the density solver** and 24 worse than the hunt-and-target heuristic. Being
the best of three models at a task where all three lose badly to a hundred lines
of plain code is not a practical result.

## Every shortlist comparison is a tie

With code ranking the top 16 and describing each in words, all three models land
between 46.0 and 49.9, and the density solver sits at 48.3 in the middle of them.
No model beats the solver, and no model beats another.

`hybrid/clef − density` is the deadest heat in the project: 0.3 shots over 60
layouts, p = 0.85, and settling it would take roughly **12,345 games**. The
others need between 210 and 1,047.

The Phase 1 conclusion therefore survives contact with two more models, and gets
stronger: the configuration where a model looks good is the configuration where
the code has already done the work, and in that configuration the model is not
adding anything measurable.

## Why Clef wins the raw-board task

The mechanism was predicted before the games were run, from
`scripts/probe-probability-rounding.mts`, and it is the clearest result here.

| backend | decimals | non-zero of 90 | mass kept | top option | at the floor |
| --- | --- | --- | --- | --- | --- |
| jev | 2 | 44.9 (50%) | 0.996 | 0.28 | 32.9 |
| clef | **4** | **90.0 (100%)** | 1.000 | 0.05 | 1.1 |
| clef-flash | **4** | **90.0 (100%)** | 1.000 | 0.05 | 1.0 |

Clef does not round the way Jev does. Jev returns two decimals, so across ~90
options about 45 come back as exactly zero and another 33 are tied on the 0.01
floor, leaving a usable ranking over roughly a dozen cells. Clef returns four
decimals and ranks all ninety.

That is exactly the task `jevPure` sets, and Clef wins it. The same property
costs it nothing in the hybrid player, where there are only 16 options and Jev's
dozen is plenty.

### Correction to the Phase 1 write-up

`docs/results.md` said rounding made "most of the distribution collapse to zero",
and the published article said only six cells came back with any value. Both are
wrong. The mass is retained — 0.996 of 1.0 — and about 45 of 90 options are
non-zero, measured at 6, 8 and 12 positions with a stable answer each time.

What collapses is the *ordering of the tail*, not the mass, and the heatmap looked
empty because 0.01 is nearly invisible on the ramp rather than because the values
were zero. The Phase 1 conclusion that `jevPure` has very little usable signal
stands; the number and the mechanism given for it do not.

## How much each model uses the code's ranking

`scripts/diagnose-game.mts` replays each game, recomputes the solver's ranking at
every shot, and reports where the model's pick landed in it.

| hybrid player | mean rank chosen | picks the top cell | mean shots |
| --- | --- | --- | --- |
| hybrid/jev | **4.68** | 26.9% | 46.0 |
| hybrid/clef | **5.92** | 27.1% | 48.6 |
| hybrid/clef-flash | **6.54** | 20.0% | 49.9 |
| chance over 16 | 7.50 | 6.25% | — |

The two columns order identically: the further a model drifts from the code's
ranking, the worse it plays. All three are well clear of chance, so all three are
genuinely reading the shortlist, and they differ in how much they defer to it.

This also explains the variance. `hybrid/clef` has the widest spread (sd 13.0)
and three games above 75 shots where Jev has none. On the worst of them, seed
1031, Clef took 99 shots to Jev's 44: mean rank chosen 8.41 of 16, the solver's
*worst* candidate picked more often than its best, and 58 of 99 shots missed
while a real ship cell sat in the shortlist. The code was working and the model
was discarding it.

`clef-flash` is the opposite profile: the lowest spread of any model player
(sd 7.8), no catastrophes, and consistently mediocre.

## Latency, measured here

40 interleaved calls per model, warm-ups discarded, machine otherwise idle, both
real payload sizes. Milliseconds, end to end, including network.

| | 16 options | | 90 options | |
| --- | --- | --- | --- | --- |
| | median | p95 | median | p95 |
| jev | **300** | **467** | **277** | **577** |
| clef | 524 | 1187 | 713 | 1111 |
| clef-flash | 350 | 774 | 425 | 874 |

Jev is the fastest of the three at both sizes, and its median is essentially flat
as the payload grows from ~760 to ~2,300 input tokens. Clef's rises by a third.

This inverts Cloudflare's announcement, which quotes medians of 38.8 ms
(clef-flash), 209.3 ms (clef) and 524.1 ms (Jev). Those figures are not
comparable to these: 38.8 ms is barely a round trip to anywhere, so they almost
certainly exclude the network. The two sets of numbers measure different things
and neither refutes the other.

The `ms/shot` column in the benchmark runs is **not** latency. Those runs pace
requests at 1500 ms, so that column reports the pacing setting. Only the table
above measures the model.

## Cost

| | billed |
| --- | --- |
| hybrid/clef | $0.6040 |
| hybrid/clef-flash | $0.2331 |
| pure/clef | $2.9463 |
| pure/clef-flash | $1.2096 |
| **the four runs reported** | **$4.99** |
| discarded runs, probes and smoke tests | $2.19 |
| **total spent** | **$7.18** |

Output tokens are free on both Clef models, so cost is driven entirely by input.
Clef at $0.240/M is 5.7× Jev's $0.042/M, and `pure/clef` cost $2.95 to finish
28 shots behind a solver that costs nothing to run.

Unlike Workers AI, which returns no cost at all, the Decisions API reports
`usage.cost` per call, so every Clef figure above is billed rather than derived
from a published rate. The two Jev figures are marked `*` because they come from
the Phase 1 run, which could only estimate.

## What these numbers do NOT establish

- **That any model beats the density solver.** Nothing here does. Three of the
  nine comparisons against `density` are ties and the rest are losses.
- **That Jev beats clef-flash at the hybrid task.** p = 0.030 against a corrected
  threshold of 0.0014. It is a tie.
- **That Clef is a better model than Jev.** It is better at one task, on one
  game, in one configuration — choosing from ~90 identically-labelled options —
  and that advantage traces to a reporting precision difference rather than to
  anything shown about judgement. At 16 options the advantage disappears.
- **That the rounding difference is the whole story.** The probe shows the
  mechanism is available; it does not prove it is the cause. A controlled test
  would need Jev at four decimals, which the API does not offer.
- **Anything about other layout families.** `mixed` only. The ranking between
  code baselines inverts across families (see `representation.md`), and nothing
  here tests whether the model ranking does too.
- **Anything about other Clef builds.** Clef reports no version string, only
  `cloudflare/clef`, so these results cannot be pinned to a build the way the Jev
  results can be pinned to `jev-1.13-20260917`. A silent model update would be
  invisible here.
- **That the latency figures describe either vendor's own endpoint.** They
  describe the path through OpenRouter, which is what makes them comparable to
  each other and not comparable to anything else.
- **That the rank diagnostic measures correctness.** It measures agreement with
  the solver's ordering. A model could in principle beat the solver by disagreeing
  with it; on these layouts, disagreement correlated with worse games.

## Reproducing

```bash
npm run bench -- --transport or-clef --layouts mixed --games 60 \
  --strategies jevPure,jevHybrid --seed 1000
npm run bench -- --transport or-clef-flash --layouts mixed --games 60 \
  --strategies jevPure,jevHybrid --seed 1000
npx tsx scripts/compare-backends.mts
npx tsx scripts/measure-latency.mts --calls 40 --options 90
npx tsx scripts/probe-probability-rounding.mts --positions 8
```

Run `jevPure` on `clef-flash` on its own. Two concurrent runs hit Cloudflare's
per-minute inference limit, and a 429 that outlasts the retry ladder kills a game.

Each call's `generationId` is in the JSON output for cross-checking against the
OpenRouter logs.
