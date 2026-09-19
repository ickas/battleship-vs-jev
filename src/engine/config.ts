import type { GameConfig, ShipSpec } from './types.js';

/** Standard Battleship fleet: 5, 4, 3, 3, 2. */
export const STANDARD_FLEET: ShipSpec[] = [
  { id: 'carrier', name: 'Carrier', length: 5 },
  { id: 'battleship', name: 'Battleship', length: 4 },
  { id: 'cruiser', name: 'Cruiser', length: 3 },
  { id: 'submarine', name: 'Submarine', length: 3 },
  { id: 'destroyer', name: 'Destroyer', length: 2 },
];

export const DEFAULT_CONFIG: GameConfig = {
  rows: 10,
  cols: 10,
  fleet: STANDARD_FLEET,
  allowTouching: true,
};

export function makeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return { ...DEFAULT_CONFIG, fleet: [...STANDARD_FLEET], ...overrides };
}

export function totalShipCells(config: GameConfig): number {
  return config.fleet.reduce((sum, ship) => sum + ship.length, 0);
}
