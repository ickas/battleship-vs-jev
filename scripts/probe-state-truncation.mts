/**
 * Does the serving stack read the whole state, and up to what size?
 *
 * OpenRouter's model card for Clef says Workers AI "currently truncates long
 * text state to roughly the first 2K tokens, so content beyond that is not
 * read". If that is true at the sizes this benchmark sends, the `jevPure`
 * comparison is invalid before it starts: Clef would be answering about half a
 * board while Jev answers about a whole one, and the result would look like a
 * weaker model rather than a truncated one.
 *
 * Measured rather than assumed. Each probe hides a marker at the very end of a
 * state padded to a target size, then asks a question only the tail can answer.
 * A model that reads the whole state scores ~100%; one that truncates scores at
 * chance once the marker falls beyond the cut.
 *
 * Jev is the control. TypeSafe serves it directly, so it should keep seeing the
 * marker at sizes where Clef stops. Without that control a low score would be
 * ambiguous between truncation and the model simply being bad at the task.
 *
 * Also calibrates characters-per-token against the input_tokens the API
 * reports, which is what makes the run budget exact rather than a guess.
 *
 *   npx tsx scripts/probe-state-truncation.mts --trials 4
 */
import { loadEnv } from '../src/env.js';
loadEnv();

import { OpenRouterClient } from '../src/jev/openrouter.js';
import type { ChoiceAnswer } from '../src/jev/types.js';

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const TRIALS = Number(flag('trials', '4'));

const MODELS = ['typesafe/jev-1.13', 'cloudflare/clef', 'cloudflare/clef-flash'] as const;

/** Target state sizes in approximate tokens, straddling the documented ~2K cut. */
const TARGET_TOKENS = [400, 1_000, 1_800, 2_600, 4_000];

/** Four plausible markers, so a model that guesses scores 25%. */
const MARKERS = ['harbour', 'lantern', 'compass', 'anchor'] as const;

/**
 * Filler that looks like the real payload rather than like lorem ipsum: the
 * same shape of per-cell board facts jevPure sends, so the tokeniser and the
 * model both see something representative.
 */
function filler(approxTokens: number): string {
  const lines: string[] = [];
  // ~3.5 characters per token is the working estimate this script then checks.
  const targetChars = Math.round(approxTokens * 3.5);
  let i = 0;
  let chars = 0;
  while (chars < targetChars) {
    const row = String.fromCharCode(65 + (i % 10));
    const col = (i % 10) + 1;
    const line = `Cell ${row}${col} was fired at and found empty water.`;
    lines.push(line);
    chars += line.length + 1;
    i++;
  }
  return lines.join('\n');
}

interface Outcome {
  correct: number;
  total: number;
  reportedInputTokens: number[];
  stateChars: number;
  errors: string[];
}

async function probe(model: string, approxTokens: number): Promise<Outcome> {
  const client = new OpenRouterClient({ model, sessionId: 'probe-state-truncation' });
  const out: Outcome = {
    correct: 0,
    total: 0,
    reportedInputTokens: [],
    stateChars: 0,
    errors: [],
  };

  for (let t = 0; t < TRIALS; t++) {
    const marker = MARKERS[t % MARKERS.length]!;
    // The marker sits at the very end, after the padding. Anything that reads
    // only a prefix cannot see it.
    const state =
      `${filler(approxTokens)}\n` +
      `FINAL INSTRUCTION: the code word for this board is "${marker}".`;
    out.stateChars = state.length;

    try {
      const res = await client.ask({
        label: `truncation.${model}.${approxTokens}`,
        state,
        questions: {
          codeword: {
            type: 'choice',
            instructions:
              'The state ends with a line naming the code word for this board. Which code word does it name?',
            criteria: Object.fromEntries(
              MARKERS.map((m) => [m, `The state names "${m}" as the code word.`]),
            ),
          },
        },
      });

      const answer = res.answers.codeword as ChoiceAnswer;
      if (answer.choice === marker) out.correct++;
      out.total++;
      if (res.usage.inputTokens !== undefined) {
        out.reportedInputTokens.push(res.usage.inputTokens);
      }
    } catch (error) {
      out.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return out;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

console.log(`Probing state truncation: ${TRIALS} trials per cell, 4 markers so chance is 25%.\n`);
console.log('model                   target_tok  state_chars  reported_tok  chars/tok  correct');
console.log('-'.repeat(84));

const calibration: number[] = [];

for (const model of MODELS) {
  for (const target of TARGET_TOKENS) {
    const r = await probe(model, target);
    const reported = mean(r.reportedInputTokens);
    const ratio = Number.isNaN(reported) ? NaN : r.stateChars / reported;
    if (!Number.isNaN(ratio)) calibration.push(ratio);

    const score = r.total ? `${r.correct}/${r.total}` : 'n/a';
    console.log(
      model.padEnd(23),
      String(target).padStart(10),
      String(r.stateChars).padStart(12),
      (Number.isNaN(reported) ? '-' : reported.toFixed(0)).padStart(13),
      (Number.isNaN(ratio) ? '-' : ratio.toFixed(2)).padStart(10),
      score.padStart(8),
      r.errors.length ? `  ERRORS: ${r.errors[0]}` : '',
    );
  }
  console.log();
}

if (calibration.length) {
  console.log(
    `Calibration: ${mean(calibration).toFixed(2)} characters per token ` +
      `(the budget estimate assumed 3.50).`,
  );
}
console.log(
  '\nRead this as: a model that keeps scoring near 4/4 as the target grows is reading the\n' +
    'whole state. One that falls toward 1/4 past a size has stopped reading the tail, and any\n' +
    'benchmark sending states above that size is measuring truncation, not judgement.',
);
