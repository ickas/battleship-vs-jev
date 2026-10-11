# Latency re-run after Cloudflare's Clef serving update

Run on 2026-10-11, two days after Cloudflare's
[post](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/) (dated
2026-10-09) saying hosted Clef is 1.7× to 2× faster after moving its serving to
SGLang, and that hosted Clef-flash is cheaper with its context cut to 24k.

This repeats the latency measurement in [results-clef.md](results-clef.md)
exactly, so the two sets of numbers can be compared. It does not change that
file.

## Method

The same script, unchanged since the 6 October run (last commit `6b22b63`,
2026-10-06 11:13, before that measurement), with the same arguments:

```bash
npx tsx scripts/measure-latency.mts --calls 40 --options 16
npx tsx scripts/measure-latency.mts --calls 40 --options 90
```

- **Endpoint:** OpenRouter Decisions API (`https://openrouter.ai/api/alpha/decisions`)
  for all three models, slugs `typesafe/jev-1.13`, `cloudflare/clef`,
  `cloudflare/clef-flash`.
- **Payload:** the script's fixed mid-game Battleship decision, padded to 16 or 90
  options. The input token counts match 6 October (Jev ~760 and ~2,300), so the
  payloads are the same.
- **Calls:** 40 per model per size, plus 3 warm-up calls each that are made but
  not counted. Calls are interleaved round-robin across the three models.
  `retries: 0`, so a slow or failed call is never hidden.
- **Timing:** end to end from this machine, network included, successful
  attempt only.

| | |
| --- | --- |
| Run | 2026-10-11, 12:06:00 to 12:07:51 WEST (16 options 12:06:00 to 12:06:52, 90 options 12:06:52 to 12:07:51) |
| Machine | MacBook Pro, Apple M1 Pro, 16 GB, macOS (Darwin 27.0.0), home network |
| n per model | 40 per size (80 per model), plus 3 + 3 warm-ups |
| Load | **Not idle.** Load average 9.5 at the start, 7.2 at the end (screen sharing, a browser and Spotlight indexing were running). The 6 October run was taken on a machine described as otherwise idle. The measurement is network-bound, but this is a difference between the two runs. |

The 6 October write-up does not record which machine it ran on.

## Results

Milliseconds, end to end. 6 October figures from [results-clef.md](results-clef.md).

### 16 options

| model | median 6 Oct | median 11 Oct | change | p95 6 Oct | p95 11 Oct |
| --- | --- | --- | --- | --- | --- |
| Jev | 300 | 319 | +6% | 467 | 389 |
| Clef | 524 | **359** | **−31% (1.46× faster)** | 1187 | 950 |
| Clef-flash | 350 | 372 | +6% | 774 | 565 |

### 90 options

| model | median 6 Oct | median 11 Oct | change | p95 6 Oct | p95 11 Oct |
| --- | --- | --- | --- | --- | --- |
| Jev | 277 | 310 | +12% | 577 | 389 |
| Clef | 713 | **496** | **−30% (1.44× faster)** | 1111 | 623 |
| Clef-flash | 425 | **622** | **+46% (slower)** | 874 | 768 |

Raw output, as the script printed it:

```
16 options
backend      n  median  p95  min   max  mean  in.tok  fail
jev         40     319  389  274   476   326     762     0
clef        40     359  950  245  1230   415     605     0
clef-flash  40     372  565  301   669   395     605     0

90 options
backend      n  median  p95  min  max  mean  in.tok  fail
jev         40     310  389  275  468   320    2301     0
clef        40     496  623  335  712   497    2429     0
clef-flash  40     622  768  327  864   564    2429     0

Model ids reported: typesafe/jev-1.13-20260917, cloudflare/clef, cloudflare/clef-flash
```

## Input tokens per payload

As reported in `usage.input_tokens`. Jev and Clef use different tokenizers, so
the same payload counts differently.

| payload | Jev | Clef and Clef-flash |
| --- | --- | --- |
| 16 options | 762 | 605 |
| 90 options | 2,301 | 2,429 |

Jev now also reports `output_tokens: 147` per call, billed at $0. Clef reports 0.

## Which provider served Clef: two of them

The script does not record the provider, so this was checked separately, with
19 extra calls outside the sample (same payload, 16 options).

The Decisions API response has a `provider` field. The generation stats endpoint
(`/api/v1/generation`) returned 404 for decision ids, so the field is the only
source.

| slug | providers OpenRouter lists | served in 1 + 8 sample calls |
| --- | --- | --- |
| `typesafe/jev-1.13` | TypeSafe | TypeSafe |
| `cloudflare/clef` | PrimeIntellect (16k ctx), Cloudflare (64k ctx) | PrimeIntellect 6, Cloudflare 3 |
| `cloudflare/clef-flash` | PrimeIntellect (16k ctx), Cloudflare (64k ctx) | PrimeIntellect 5, Cloudflare 4 |

**OpenRouter splits Clef and Clef-flash traffic between PrimeIntellect and
Cloudflare.** The 40-call samples above therefore mix two serving stacks, in
unknown proportions, and Cloudflare's SGLang change can only apply to the share
that went to Cloudflare. That limits what these numbers say about the update:

- The Clef speedup through OpenRouter (1.44× to 1.46× at the median) is real for
  a caller, but it is a blend. It cannot be compared with Cloudflare's 1.7× to 2×
  figures, which are for Workers AI alone and do not say whether network is
  included.
- The Clef-flash slowdown at 90 options could come from the provider mix rather
  than from either provider getting slower.
- Clef's long tail at 16 options (p95 950, max 1230, against a median of 359) is
  consistent with two providers of different speed, but this run cannot show it.
- The 6 October run did not record providers either, so it is not known whether
  it was already mixed.

OpenRouter still lists Clef-flash's Cloudflare endpoint with a 65,536 context;
Cloudflare's post says the hosted context is now 24k. The listing may lag.

## Prices OpenRouter shows now

Per million input tokens, from `/api/v1/models/<slug>/endpoints` (the decision
models are not in the public `/models` list). Output is $0 for all three.

| model | 11 Oct | before |
| --- | --- | --- |
| Jev | $0.042 | $0.042 |
| Clef | $0.24 | $0.24 |
| Clef-flash | **$0.038** | $0.09 |

Both providers charge the same price for each Clef model. The billed `usage.cost`
on sample calls matches these rates exactly. Clef-flash is now cheaper per input
token than Jev, as Cloudflare's post says.

## Cost of this run

From the OpenRouter credit balance before and after:

| | |
| --- | --- |
| Two measurement runs (258 calls incl. warm-ups) and 3 provider look-ups | $0.0418 |
| 16 further provider-sampling calls | $0.0002 |
| **Total** | **$0.0420** |

## Failures and anomalies

- **No call failed.** 0 failures in all 240 measured calls and the 18 warm-ups.
- **No timeout or retry.** Retries are off in this script, so none were hidden.
- **One long tail:** Clef at 16 options, max 1,230 ms and p95 950 ms against a
  median of 359 ms. Not an error, and not attributable to a provider with this
  data (see above).

## Not run: Workers AI directly

The optional direct Workers AI line was not run. `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` are not set in `.env.local`.

## What would settle it

Pin the provider: OpenRouter accepts a provider preference per request
(`provider: { order: ["Cloudflare"], allow_fallbacks: false }`), and the same
again for PrimeIntellect. That needs a change to the script, so it was not done
here. It would give one Cloudflare-only and one PrimeIntellect-only line for
each Clef model, and show which provider the update reached.
