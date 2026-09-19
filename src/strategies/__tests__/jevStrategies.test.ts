import { describe, expect, it } from 'vitest';
import { Board } from '../../engine/board.js';
import { makeConfig } from '../../engine/config.js';
import { playGame } from '../../engine/game.js';
import { randomFleet } from '../../engine/placement.js';
import { makeRng } from '../../engine/rng.js';
import { MockJevClient } from '../../jev/mock.js';
import type { JevClient, JevRequest, JevResponse, JevCallLog } from '../../jev/types.js';
import { JevHybridStrategy } from '../jevHybrid.js';
import { JevPureStrategy } from '../jevPure.js';

const config = makeConfig();

/** A client that returns a scripted Choice answer, to exercise specific paths. */
class ScriptedClient implements JevClient {
  readonly log: JevCallLog[] = [];
  readonly stats = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalLatencyMs: 0 };
  lastRequest?: JevRequest;

  constructor(private readonly reply: (request: JevRequest) => JevResponse) {}

  async ask(request: JevRequest): Promise<JevResponse> {
    this.lastRequest = request;
    this.stats.calls++;
    return this.reply(request);
  }
}

function choiceReply(choice: string, probabilities?: Record<string, number>): JevResponse {
  return {
    answers: { target: { type: 'choice', choice, probabilities } },
    confidence: { target: 0.77 },
    usage: { inputTokens: 100, outputTokens: 5 },
    modelId: 'jev-1.13.0',
    latencyMs: 1,
  };
}

describe('JevPureStrategy', () => {
  it('offers every untried cell and records model metadata', async () => {
    const client = new ScriptedClient(() => choiceReply('C3', { C3: 0.9, D4: 0.1 }));
    const strategy = new JevPureStrategy({ client });
    const view = new Board(config, randomFleet(config, makeRng(1))).view();

    const decision = await strategy.nextShot(view, makeRng(1));

    const question = client.lastRequest!.questions.target!;
    expect(question.type).toBe('choice');
    expect(Object.keys((question as { criteria: object }).criteria)).toHaveLength(100);
    expect(decision.coord).toEqual({ row: 2, col: 2 });
    expect(decision.confidence).toBe(0.77);
    expect(decision.modelId).toBe('jev-1.13.0');
    expect(decision.usage).toEqual({ inputTokens: 100, outputTokens: 5 });
  });

  it('builds a heatmap from the returned probabilities', async () => {
    const client = new ScriptedClient(() => choiceReply('A1', { A1: 0.6, B1: 0.4 }));
    const strategy = new JevPureStrategy({ client });
    const view = new Board(config, randomFleet(config, makeRng(1))).view();

    const decision = await strategy.nextShot(view, makeRng(1));
    expect(decision.heatmap![0]![0]).toBe(0.6);
    expect(decision.heatmap![0]![1]).toBe(0.4);
    expect(decision.heatmap![5]![5]).toBe(0);
  });

  it('falls back to a legal cell when the model returns an unusable label', async () => {
    const client = new ScriptedClient(() => choiceReply('not-a-cell', { B2: 0.5, C3: 0.9 }));
    const strategy = new JevPureStrategy({ client });
    const view = new Board(config, randomFleet(config, makeRng(1))).view();

    const decision = await strategy.nextShot(view, makeRng(1));
    expect(decision.coord).toEqual({ row: 2, col: 2 }); // highest-probability legal cell
    expect(decision.notes).toMatch(/fell back/);
  });

  it('falls back when the model picks a cell already fired at', async () => {
    const board = new Board(config, randomFleet(config, makeRng(1)));
    board.fire({ row: 0, col: 0 });
    const client = new ScriptedClient(() => choiceReply('A1'));
    const strategy = new JevPureStrategy({ client });

    const decision = await strategy.nextShot(board.view(), makeRng(1));
    expect(decision.coord).not.toEqual({ row: 0, col: 0 });
    expect(decision.notes).toMatch(/fell back/);
  });

  it('copes with a response carrying no probabilities', async () => {
    const client = new ScriptedClient(() => choiceReply('E5'));
    const strategy = new JevPureStrategy({ client });
    const view = new Board(config, randomFleet(config, makeRng(1))).view();

    const decision = await strategy.nextShot(view, makeRng(1));
    expect(decision.coord).toEqual({ row: 4, col: 4 });
    expect(decision.heatmap).toBeUndefined();
  });

  it('skips the model call when only one cell remains', async () => {
    const board = new Board(config, randomFleet(config, makeRng(1)));
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        if (row === 9 && col === 9) continue;
        if (!board.isFleetSunk) board.fire({ row, col });
      }
    }
    if (!board.isFleetSunk) {
      const client = new ScriptedClient(() => choiceReply('J10'));
      const strategy = new JevPureStrategy({ client });
      const decision = await strategy.nextShot(board.view(), makeRng(1));
      expect(client.stats.calls).toBe(0);
      expect(decision.notes).toMatch(/no model call/);
    }
  });

  it('samples from the distribution when temperature is above zero', async () => {
    const client = new ScriptedClient(() => choiceReply('A1', { A1: 0.5, B1: 0.5 }));
    const strategy = new JevPureStrategy({ client, temperature: 1 });
    const view = new Board(config, randomFleet(config, makeRng(1))).view();

    const picks = new Set<string>();
    for (let seed = 0; seed < 25; seed++) {
      const decision = await strategy.nextShot(view, makeRng(seed));
      picks.add(`${decision.coord.row},${decision.coord.col}`);
    }
    // With two equally weighted options, sampling must not always return the same cell.
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe('JevHybridStrategy', () => {
  it('offers only the top-K code-ranked candidates, described in words', async () => {
    const client = new ScriptedClient((request) => {
      const criteria = (request.questions.target as { criteria: Record<string, string> }).criteria;
      return choiceReply(Object.keys(criteria)[0]!);
    });
    const strategy = new JevHybridStrategy({ client, topK: 6 });
    const view = new Board(config, randomFleet(config, makeRng(2))).view();

    await strategy.nextShot(view, makeRng(2));

    const criteria = (client.lastRequest!.questions.target as { criteria: Record<string, string> })
      .criteria;
    expect(Object.keys(criteria)).toHaveLength(6);
    // Descriptions are prose, not numbers.
    for (const description of Object.values(criteria)) {
      expect(description).toMatch(/board|water|ship|hit|space/);
    }
  });
});

describe('full games with the mock client', () => {
  it('both Jev strategies finish a game without an illegal shot', async () => {
    for (const build of [
      (client: JevClient) => new JevPureStrategy({ client }),
      (client: JevClient) => new JevHybridStrategy({ client, topK: 8 }),
    ]) {
      const fleet = randomFleet(config, makeRng(5));
      let currentView: ReturnType<Board['view']> | undefined;
      const client = new MockJevClient({ viewProvider: () => currentView });
      const strategy = build(client);

      const result = await playGame({
        config,
        fleet,
        strategy,
        rng: makeRng(5),
        seed: 5,
        onShot: (_record, board) => {
          currentView = board.view();
        },
      });

      expect(result.won).toBe(true);
      const labels = result.shots.map((s) => s.label);
      expect(new Set(labels).size).toBe(labels.length);
      expect(result.shots.every((s) => s.modelId !== undefined || s.notes?.includes('no model call'))).toBe(true);
    }
  }, 30_000);
});
