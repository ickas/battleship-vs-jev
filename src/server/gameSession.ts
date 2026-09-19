import { randomUUID } from 'node:crypto';
import { Board } from '../engine/board.js';
import { makeConfig } from '../engine/config.js';
import { coordToLabel } from '../engine/coords.js';
import { randomFleet } from '../engine/placement.js';
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
  /** Player-supplied layout. A random valid fleet is generated when absent. */
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

  private readonly board: Board;
  private readonly rng: Rng;
  private readonly records: ShotRecord[] = [];
  private lastError?: string;

  constructor(options: CreateSessionOptions) {
    this.config = makeConfig({ allowTouching: options.allowTouching ?? true });
    const seed = options.seed ?? Math.floor(Math.random() * 1e9);
    this.rng = makeRng(seed);

    const fleet = options.fleet ?? randomFleet(this.config, makeRng(seed));
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

  /** Takes one shot. Returns the record, or throws with the reason it failed. */
  async step(): Promise<ShotRecord> {
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
