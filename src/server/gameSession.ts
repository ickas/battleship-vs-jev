import { randomUUID } from 'node:crypto';
import { Board } from '../engine/board.js';
import { makeConfig } from '../engine/config.js';
import { coordToLabel } from '../engine/coords.js';
import { makeLayout, type LayoutFamily } from '../engine/layouts.js';
import { makeRng, type Rng } from '../engine/rng.js';
import type { GameConfig, PlacedShip } from '../engine/types.js';
import type { ShotRecord } from '../engine/game.js';
import type { JevClient } from '../jev/types.js';
import { buildStrategy } from '../bench/strategies.js';
import type { Strategy } from '../strategies/types.js';

export interface CreateSessionOptions {
  strategyId: string;
  representation?: string;
  topK?: number;
  temperature?: number;
  seed?: number;
  allowTouching?: boolean;
  /**
   * Which family of fleet layout to generate. The family changes the answer -
   * see src/engine/layouts.ts - so it is recorded in the snapshot.
   */
  layoutFamily?: LayoutFamily;
  /** Player-supplied layout. Overrides `layoutFamily` when present. */
  fleet?: PlacedShip[];
  client: JevClient;
}

/**
 * One in-progress game for the UI: Mode 1, a strategy hunting a fixed fleet.
 * The browser drives it one shot at a time, so each step can be rendered live.
 */
export class GameSession {
  readonly id = randomUUID();
  readonly config: GameConfig;
  readonly strategy: Strategy;
  readonly createdAt = new Date().toISOString();
  readonly seed: number;
  readonly layoutFamily: LayoutFamily | 'manual';

  private readonly board: Board;
  private readonly rng: Rng;
  private readonly records: ShotRecord[] = [];
  private lastError?: string;
  /**
   * Serializes shots. Two overlapping requests would otherwise both pass the
   * isOver check and call the strategy against the same board, so the second
   * could pick a cell the first was about to fire at.
   */
  private inFlight: Promise<ShotRecord> | undefined;

  constructor(options: CreateSessionOptions) {
    this.config = makeConfig({ allowTouching: options.allowTouching ?? true });
    this.seed = options.seed ?? Math.floor(Math.random() * 1e9);
    this.rng = makeRng(this.seed);

    this.layoutFamily = options.fleet ? 'manual' : (options.layoutFamily ?? 'random');
    const fleet =
      options.fleet ?? makeLayout(this.layoutFamily as LayoutFamily, this.config, makeRng(this.seed));
    this.board = new Board(this.config, fleet);

    this.strategy = buildStrategy(options.strategyId, {
      client: options.client,
      representation: options.representation,
      topK: options.topK,
      temperature: options.temperature,
    });
  }

  get isOver(): boolean {
    return this.board.isFleetSunk;
  }

  /**
   * Takes one shot. Returns the record, or throws with the reason it failed.
   * Concurrent calls queue behind each other rather than racing.
   */
  async step(): Promise<ShotRecord> {
    const previous = this.inFlight?.catch(() => undefined) ?? Promise.resolve();
    const next = previous.then(() => this.stepOnce());
    this.inFlight = next;
    try {
      return await next;
    } finally {
      if (this.inFlight === next) this.inFlight = undefined;
    }
  }

  private async stepOnce(): Promise<ShotRecord> {
    if (this.isOver) throw new Error('The game is already over');

    const startedAt = performance.now();
    const decision = await this.strategy.nextShot(this.board.view(), this.rng);
    const latencyMs = performance.now() - startedAt;

    if (this.board.hasBeenShot(decision.coord)) {
      throw new Error(
        `Strategy chose ${coordToLabel(decision.coord)}, which was already fired at`,
      );
    }

    const outcome = this.board.fire(decision.coord);
    const record: ShotRecord = {
      index: this.records.length + 1,
      label: coordToLabel(decision.coord),
      outcome,
      latencyMs,
      heatmap: decision.heatmap,
      heatmapSource: decision.heatmapSource,
      confidence: decision.confidence,
      notes: decision.notes,
      usage: decision.usage,
      modelId: decision.modelId,
      generationId: decision.generationId,
      marketCostUsd: decision.marketCostUsd,
      costIsEstimated: decision.costIsEstimated,
      attempts: decision.attempts,
      retryWaitMs: decision.retryWaitMs,
    };
    this.records.push(record);
    return record;
  }

  /** Everything the browser needs to render. Ship positions only once the game ends. */
  snapshot() {
    const view = this.board.view();
    const hits = this.records.filter((r) => r.outcome.result !== 'miss').length;
    const shots = this.records.length;

    return {
      id: this.id,
      strategy: { id: this.strategy.id, name: this.strategy.name, usesModel: this.strategy.usesModel },
      seed: this.seed,
      layoutFamily: this.layoutFamily,
      config: this.config,
      cells: view.cells,
      sunkShipIds: view.sunkShipIds,
      remainingShipLengths: view.remainingShipLengths,
      shots,
      hits,
      misses: shots - hits,
      accuracy: shots > 0 ? hits / shots : 0,
      isOver: this.isOver,
      lastError: this.lastError,
      totalLatencyMs: this.records.reduce((sum, r) => sum + r.latencyMs, 0),
      totalInputTokens: this.records.reduce((sum, r) => sum + (r.usage?.inputTokens ?? 0), 0),
      totalOutputTokens: this.records.reduce((sum, r) => sum + (r.usage?.outputTokens ?? 0), 0),
      modelIds: [...new Set(this.records.map((r) => r.modelId).filter(Boolean))],
      generationIds: this.records.map((r) => r.generationId).filter(Boolean),
      totalCostUsd: this.records.reduce((sum, r) => sum + (r.marketCostUsd ?? 0), 0),
      costIsEstimated: this.records.some((r) => r.costIsEstimated),
      /** Cost of the most recent shot, for the metrics panel. */
      lastShotCostUsd: this.records.at(-1)?.marketCostUsd,
      history: this.records.map((r) => ({
        index: r.index,
        label: r.label,
        result: r.outcome.result,
        latencyMs: Math.round(r.latencyMs),
        confidence: r.confidence,
        notes: r.notes,
        inputTokens: r.usage?.inputTokens,
      })),
      heatmap: this.records.at(-1)?.heatmap,
      heatmapSource: this.records.at(-1)?.heatmapSource,
      // Revealed only once the game is over, so the UI cannot leak the answer.
      fleet: this.isOver ? this.board.fleet : undefined,
    };
  }

  recordError(message: string): void {
    this.lastError = message;
  }
}
