/**
 * UI for Mode 1: a strategy hunts a fixed fleet.
 * All Jev calls happen on the server, which holds the API key.
 */

const LETTERS = 'ABCDEFGHIJ';
const el = (id) => document.getElementById(id);

/**
 * Settings that define a run, mirrored to the query string so a link
 * reproduces it. Deliberately excludes mock mode: that is a server-side switch
 * (JEV_MOCK) because it changes what the numbers mean rather than what is being
 * measured, and a link that quietly disables the model would be a trap.
 */
const URL_KEYS = ['strategy', 'representation', 'layout', 'seed', 'topK', 'temperature'];

/** Discrete heatmap bands. Six reads clearly on a 10x10 grid. */
const BANDS = 6;

/** Keeps very small figures legible rather than rounding them to zero. */
function formatUsd(amount) {
  if (amount === 0) return '$0';
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const out = {};
  for (const key of URL_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== '') out[key] = value;
  }
  return out;
}

/** Writes the current controls to the URL without adding a history entry. */
function writeUrlState() {
  const params = new URLSearchParams();
  params.set('strategy', el('strategy').value);
  params.set('layout', el('layout-mode').value);

  // Only include what actually applies to the current selection.
  const usesModel = strategyUsesModel(el('strategy').value);
  if (usesModel) params.set('representation', el('representation').value);
  if (el('layout-mode').value !== 'manual') params.set('seed', el('seed').value);

  const url = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, '', url);
}

function strategyUsesModel(id) {
  return state.config?.strategies.find((s) => s.id === id)?.usesModel ?? false;
}

const state = {
  config: null,
  game: null,
  autoPlaying: false,
  abort: false,
  // Manual fleet placement, used when layout mode is "manual".
  placing: {
    active: false,
    orientation: 'horizontal',
    selectedShipId: null,
    // shipId -> { id, bow: {row, col}, orientation }
    placed: new Map(),
  },
};

/** Cells a ship would occupy. Mirrors the engine, for preview only. */
function shipCells(bow, length, orientation) {
  return Array.from({ length }, (_, i) =>
    orientation === 'horizontal'
      ? { row: bow.row, col: bow.col + i }
      : { row: bow.row + i, col: bow.col },
  );
}

/** Whether a placement fits the board and misses every other placed ship. */
function placementFits(cells, config, ignoreShipId) {
  const occupied = new Set();
  for (const ship of state.placing.placed.values()) {
    if (ship.id === ignoreShipId) continue;
    const spec = state.config.defaultConfig.fleet.find((s) => s.id === ship.id);
    for (const cell of shipCells(ship.bow, spec.length, ship.orientation)) {
      occupied.add(`${cell.row}-${cell.col}`);
    }
  }

  return cells.every(
    (cell) =>
      cell.row >= 0 &&
      cell.row < config.rows &&
      cell.col >= 0 &&
      cell.col < config.cols &&
      !occupied.has(`${cell.row}-${cell.col}`),
  );
}

function nextUnplacedShip() {
  return state.config.defaultConfig.fleet.find((spec) => !state.placing.placed.has(spec.id));
}

function renderFleetList() {
  const list = el('fleet-list');
  list.innerHTML = '';

  for (const spec of state.config.defaultConfig.fleet) {
    const placed = state.placing.placed.get(spec.id);
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.placing.selectedShipId === spec.id));
    button.addEventListener('click', () => {
      state.placing.selectedShipId = spec.id;
      // Re-placing a ship lifts it off the board first.
      state.placing.placed.delete(spec.id);
      renderPlacement();
    });

    const name = document.createElement('span');
    name.textContent = `${spec.name} (${spec.length})`;

    const status = document.createElement('span');
    status.className = placed ? 'placed' : 'pending';
    status.textContent = placed
      ? `${LETTERS[placed.bow.col]}${placed.bow.row + 1} ${placed.orientation === 'horizontal' ? '→' : '↓'}`
      : 'not placed';

    button.append(name, status);
    li.appendChild(button);
    list.appendChild(li);
  }

  const remaining = state.config.defaultConfig.fleet.length - state.placing.placed.size;
  el('placement-hint').textContent =
    remaining === 0
      ? 'Fleet complete. Start the game when you are ready.'
      : `Pick a ship, then click a cell to put its bow there. ${remaining} left to place.`;
  el('new-game').disabled = remaining > 0;
}

/** Draws the board in placement mode: own ships, plus a hover preview. */
function renderPlacement(preview) {
  const config = state.config.defaultConfig;
  const ownCells = new Map();
  for (const ship of state.placing.placed.values()) {
    const spec = config.fleet.find((s) => s.id === ship.id);
    for (const cell of shipCells(ship.bow, spec.length, ship.orientation)) {
      ownCells.set(`${cell.row}-${cell.col}`, ship.id);
    }
  }

  for (let row = 0; row < config.rows; row++) {
    for (let col = 0; col < config.cols; col++) {
      const node = el(`cell-${row}-${col}`);
      if (!node) continue;
      node.className = 'cell placing';
      node.textContent = '';
      node.removeAttribute('title');
      node.style.removeProperty('--heat-alpha');
      delete node.dataset.heat;
      if (ownCells.has(`${row}-${col}`)) node.classList.add('own-ship');
    }
  }

  if (preview) {
    for (const cell of preview.cells) {
      const node = el(`cell-${cell.row}-${cell.col}`);
      if (node) node.classList.add(preview.ok ? 'preview-ok' : 'preview-bad');
    }
  }

  renderFleetList();
}

function handlePlacementHover(row, col) {
  const shipId = state.placing.selectedShipId;
  if (!shipId) return;
  const spec = state.config.defaultConfig.fleet.find((s) => s.id === shipId);
  const cells = shipCells({ row, col }, spec.length, state.placing.orientation);
  renderPlacement({
    cells,
    ok: placementFits(cells, state.config.defaultConfig, shipId),
  });
}

function handlePlacementClick(row, col) {
  const shipId = state.placing.selectedShipId;
  if (!shipId) {
    const complete = state.placing.placed.size === state.config.defaultConfig.fleet.length;
    showError(
      complete
        ? 'Your fleet is complete. Pick a ship from the list to move it.'
        : 'Pick a ship from the list first.',
    );
    return;
  }

  const spec = state.config.defaultConfig.fleet.find((s) => s.id === shipId);
  const cells = shipCells({ row, col }, spec.length, state.placing.orientation);
  if (!placementFits(cells, state.config.defaultConfig, shipId)) {
    showError(`${spec.name} does not fit there.`);
    return;
  }

  showError('');
  state.placing.placed.set(shipId, {
    id: shipId,
    bow: { row, col },
    orientation: state.placing.orientation,
  });

  const next = nextUnplacedShip();
  state.placing.selectedShipId = next ? next.id : null;
  renderPlacement();
}

function setLayoutMode(mode, { startGame = true } = {}) {
  const manual = mode === 'manual';
  const family = state.config.layoutFamilies?.find((f) => f.id === mode);
  el('layout-hint').textContent = manual
    ? 'Place each ship yourself, then start the game.'
    : (family?.description ?? '');
  writeUrlState();
  state.placing.active = manual;
  state.game = null;
  el('seed-field').hidden = manual;
  el('placement-field').hidden = !manual;

  if (manual) {
    state.placing.placed.clear();
    state.placing.selectedShipId = state.config.defaultConfig.fleet[0].id;
    buildBoard(state.config.defaultConfig.rows, state.config.defaultConfig.cols);
    renderPlacement();
    el('step').disabled = true;
    el('auto').disabled = true;
    state.game = null;
  } else {
    el('new-game').disabled = false;
    // On first load init starts the game itself, so don't start a second one.
    if (startGame) newGame();
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? `Request failed (${response.status})`);
    error.snapshot = body.snapshot;
    throw error;
  }
  return body;
}

function showError(message) {
  const node = el('error');
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = message;
}

function buildBoard(rows, cols) {
  const board = el('board');
  board.innerHTML = '';
  board.style.gridTemplateColumns = `auto repeat(${cols}, 1fr)`;

  board.appendChild(headCell(''));
  for (let col = 0; col < cols; col++) board.appendChild(headCell(LETTERS[col] ?? String(col)));

  for (let row = 0; row < rows; row++) {
    board.appendChild(headCell(String(row + 1)));
    for (let col = 0; col < cols; col++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.id = `cell-${row}-${col}`;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `${LETTERS[col]}${row + 1}`);
      // Placement only applies before a game starts, or once one has finished.
      const placementEditable = () =>
        state.placing.active && (!state.game || state.game.isOver);
      cell.addEventListener('click', () => {
        if (placementEditable()) handlePlacementClick(row, col);
      });
      cell.addEventListener('mouseenter', () => {
        if (placementEditable()) handlePlacementHover(row, col);
      });
      board.appendChild(cell);
    }
  }
}

function headCell(text) {
  const node = document.createElement('div');
  node.className = 'head';
  node.textContent = text;
  return node;
}

function render(game) {
  state.game = game;
  const { cells, heatmap, config } = game;

  /*
   * Rescale the heatmap against its own maximum over cells that are still
   * unknown. Code strategies already emit max-normalized weights, but Jev
   * returns a true distribution over every option: across ~100 cells the top
   * probability is often around 0.01, which would shade to nothing. Rescaling
   * preserves the relative ordering, which is what the heatmap is for, while
   * the raw values stay in the shot log.
   */
  let heatMax = 0;
  let ratedCells = 0;
  if (heatmap) {
    for (let row = 0; row < config.rows; row++) {
      for (let col = 0; col < config.cols; col++) {
        if (cells[row][col] !== 'unknown') continue;
        if (heatmap[row][col] > heatMax) heatMax = heatmap[row][col];
        if (heatmap[row][col] > 0) ratedCells++;
      }
    }
  }

  // Highlight the most recent shot.
  const last = game.history.at(-1);
  const lastCoord = last
    ? { row: Number(last.label.slice(1)) - 1, col: LETTERS.indexOf(last.label[0]) }
    : null;

  const shipCells = new Set(
    (game.fleet ?? []).flatMap((ship) => ship.cells.map((c) => `${c.row}-${c.col}`)),
  );

  for (let row = 0; row < config.rows; row++) {
    for (let col = 0; col < config.cols; col++) {
      const node = el(`cell-${row}-${col}`);
      if (!node) continue;

      const value = cells[row][col];
      node.className = `cell ${value === 'unknown' ? '' : value}`.trim();

      // Only unknown cells the model actually rated get a band.
      const heat = value === 'unknown' && heatmap && heatMax > 0 ? heatmap[row][col] / heatMax : 0;
      if (heat > 0) {
        // Six bands by share of the strongest cell. Absolute probabilities are
        // tiny when many options are offered, so banding relative to the
        // maximum is what makes the ordering visible.
        node.dataset.band = String(Math.max(1, Math.min(BANDS, Math.ceil(heat * BANDS))));
        const raw = heatmap[row][col];
        node.title = `${LETTERS[col]}${row + 1}: ${(raw * 100).toFixed(raw < 0.01 ? 2 : 1)}%`;
      } else {
        delete node.dataset.band;
        node.removeAttribute('title');
      }

      if (value === 'unknown' && shipCells.has(`${row}-${col}`)) {
        node.classList.add('ship-revealed');
      }
      if (lastCoord && lastCoord.row === row && lastCoord.col === col) {
        node.classList.add('latest');
      }
      node.textContent = value === 'miss' ? '.' : value === 'unknown' ? '' : 'X';
    }
  }

  el('m-shots').textContent = String(game.shots);
  el('m-hits').textContent = String(game.hits);
  el('m-accuracy').textContent = `${Math.round(game.accuracy * 100)}%`;
  el('m-ships').textContent = String(game.remainingShipLengths.length);
  el('m-latency').textContent = last ? `${last.latencyMs} ms` : '-';
  el('m-total-latency').textContent = game.totalLatencyMs
    ? `${(game.totalLatencyMs / 1000).toFixed(1)} s`
    : '-';
  el('m-tokens').textContent = game.totalInputTokens ? game.totalInputTokens.toLocaleString() : '-';

  // Cost: reported by the transport where possible, otherwise computed from the
  // published rate. The label says which, so an estimate is never read as a bill.
  const cost = game.totalCostUsd ?? 0;
  el('m-cost').textContent = cost > 0 ? formatUsd(cost) : '-';
  el('m-cost-label').textContent = game.costIsEstimated ? 'Cost (est.)' : 'Cost';
  el('m-cost-label').title = game.costIsEstimated
    ? 'Estimated from the published rate of $0.042 per million input tokens, ' +
      'because the TypeSafe API does not report a cost per call.'
    : 'Reported by the Gateway for these calls.';
  el('m-cost-shot').textContent =
    cost > 0 && game.shots > 0 ? formatUsd(cost / game.shots) : '-';

  const confidences = game.history.map((h) => h.confidence).filter((c) => typeof c === 'number');
  el('m-confidence').textContent = confidences.length
    ? (confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(2)
    : '-';

  el('m-model').textContent = game.modelIds.length
    ? `Model: ${game.modelIds.join(', ')}`
    : 'Model: not a model call';

  // The scale, and how many cells it actually covers.
  const scale = el('scale');
  if (scale) {
    scale.hidden = !heatmap || heatMax <= 0;
    if (!scale.hidden) {
      const isModel = game.heatmapSource === 'model';
      el('scale-title').textContent = isModel ? "Jev's probability" : 'code-side density';
      el('scale-note').textContent = isModel
        ? `${ratedCells} cell${ratedCells === 1 ? '' : 's'} rated by the model this shot; ` +
          `strongest ${(heatMax * 100).toFixed(heatMax < 0.01 ? 2 : 1)}%. ` +
          'Cells it was not asked about, or that rounded to zero, are unshaded.'
        : `${ratedCells} cells ranked by the density code; the model returned no distribution.`;
    }
  }

  const heatLabel = el('heat-source');
  if (heatLabel) {
    heatLabel.textContent = !heatmap
      ? 'No heatmap for this shot.'
      : game.heatmapSource === 'code-density'
        ? 'Shading is the code-side density: the model returned no distribution.'
        : game.heatmapSource === 'model'
          ? "Shading is Jev's own per-option probabilities, rescaled to the strongest cell."
          : 'Shading is the code-side probability density.';
  }

  renderLog(game.history);

  el('step').disabled = game.isOver;
  el('auto').disabled = game.isOver;
  if (game.isOver) {
    el('auto').textContent = 'Auto-play';
    state.autoPlaying = false;
    showError('');
  }
}

function renderLog(history) {
  const log = el('log');
  log.innerHTML = '';
  for (const entry of [...history].reverse()) {
    const li = document.createElement('li');

    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(entry.index);

    const name = document.createElement('span');
    name.className = 'cellname';
    name.textContent = entry.label;

    const result = document.createElement('span');
    result.className = `result ${entry.result}`;
    result.textContent = entry.result;

    const meta = document.createElement('span');
    meta.className = 'meta';
    const bits = [`${entry.latencyMs} ms`];
    if (typeof entry.confidence === 'number') bits.push(`conf ${entry.confidence.toFixed(2)}`);
    if (entry.inputTokens) bits.push(`${entry.inputTokens} tok`);
    meta.textContent = bits.join('  ');

    li.append(n, name, result, meta);
    if (entry.notes) li.title = entry.notes;
    log.appendChild(li);
  }
}

async function newGame() {
  showError('');
  state.abort = true;
  state.autoPlaying = false;
  el('auto').textContent = 'Auto-play';

  const body = {
    strategyId: el('strategy').value,
    representation: el('representation').value,
    seed: Number(el('seed').value),
    layoutFamily: el('layout-mode').value,
  };

  if (state.placing.active) {
    if (state.placing.placed.size !== state.config.defaultConfig.fleet.length) {
      showError('Place every ship before starting.');
      return;
    }
    // Only id, bow and orientation are sent; the server derives the cells.
    body.fleet = [...state.placing.placed.values()];
  }

  try {
    const game = await api('/api/games', { method: 'POST', body: JSON.stringify(body) });
    // `placing.active` stays tied to the select, so a second "New game" in
    // manual mode still sends the fleet instead of silently going random.
    // Board clicks are gated on there being no game in progress.
    buildBoard(game.config.rows, game.config.cols);
    render(game);
  } catch (error) {
    showError(error.message);
  }
}

async function step() {
  if (!state.game || state.game.isOver) return false;
  const gameId = state.game.id;
  try {
    const game = await api(`/api/games/${gameId}/shot`, { method: 'POST' });
    // A slow shot can land after "New game" replaced the session; drop it.
    if (state.game?.id !== gameId) return false;
    render(game);
    return !game.isOver;
  } catch (error) {
    showError(error.message);
    if (error.snapshot) render(error.snapshot);
    return false;
  }
}

async function toggleAuto() {
  if (state.autoPlaying) {
    state.abort = true;
    state.autoPlaying = false;
    el('auto').textContent = 'Auto-play';
    return;
  }

  state.autoPlaying = true;
  state.abort = false;
  el('auto').textContent = 'Stop';

  while (state.autoPlaying && !state.abort) {
    const shouldContinue = await step();
    if (!shouldContinue) break;
  }

  state.autoPlaying = false;
  el('auto').textContent = 'Auto-play';
}

function syncStrategyHints() {
  const strategyId = el('strategy').value;
  const usesModel = strategyUsesModel(strategyId);
  writeUrlState();

  el('representation-field').style.display = usesModel ? '' : 'none';
  el('strategy-hint').textContent = usesModel
    ? 'Calls Jev for every shot. Latency and tokens are real.'
    : 'Pure code. No model calls, so latency is sub-millisecond.';

  const representation = state.config.representations.find(
    (r) => r.id === el('representation').value,
  );
  el('representation-hint').textContent = representation?.description ?? '';
}

async function init() {
  state.config = await api('/api/config');

  const strategySelect = el('strategy');
  for (const strategy of state.config.strategies) {
    const option = document.createElement('option');
    option.value = strategy.id;
    option.textContent = strategy.usesModel ? `${strategy.id} (Jev)` : strategy.id;
    strategySelect.appendChild(option);
  }
  strategySelect.value = 'density';

  const representationSelect = el('representation');
  for (const representation of state.config.representations) {
    const option = document.createElement('option');
    option.value = representation.id;
    option.textContent = representation.name;
    representationSelect.appendChild(option);
  }
  representationSelect.value = 'semantic';

  // Fleet layout: the families the server offers, plus manual placement.
  const layoutSelect = el('layout-mode');
  for (const family of state.config.layoutFamilies ?? []) {
    const option = document.createElement('option');
    option.value = family.id;
    option.textContent = family.id.charAt(0).toUpperCase() + family.id.slice(1);
    option.title = family.description;
    layoutSelect.appendChild(option);
  }
  const manualOption = document.createElement('option');
  manualOption.value = 'manual';
  manualOption.textContent = 'Place it myself';
  layoutSelect.appendChild(manualOption);
  layoutSelect.value = 'random';

  // A link fully determines the run, so apply the URL before anything else.
  const fromUrl = readUrlState();
  if (fromUrl.strategy && state.config.strategies.some((s) => s.id === fromUrl.strategy)) {
    strategySelect.value = fromUrl.strategy;
  }
  if (
    fromUrl.representation &&
    state.config.representations.some((r) => r.id === fromUrl.representation)
  ) {
    representationSelect.value = fromUrl.representation;
  }
  if (fromUrl.layout && [...layoutSelect.options].some((o) => o.value === fromUrl.layout)) {
    layoutSelect.value = fromUrl.layout;
  }
  if (fromUrl.seed !== undefined && Number.isFinite(Number(fromUrl.seed))) {
    el('seed').value = String(Math.max(0, Math.trunc(Number(fromUrl.seed))));
  }

  if (state.config.mockMode) {
    el('mock-banner').hidden = false;
  }

  const status = el('client-status');
  if (state.config.mockMode) {
    status.textContent = 'Mock mode: not the real model';
    status.classList.add('offline');
  } else if (state.config.liveClientAvailable) {
    status.textContent =
      state.config.transport === 'direct'
        ? 'Live: TypeSafe API (direct)'
        : 'Live: Vercel AI Gateway';
    status.classList.add('live');
  } else {
    status.textContent = 'No API key: Jev strategies unavailable';
    status.classList.add('offline');
  }

  const subtitle = document.querySelector('.subtitle');
  if (subtitle) {
    subtitle.textContent = state.config.liveClientAvailable
      ? state.config.transport === 'direct'
        ? "Benchmarking TypeSafe's System One model as a Battleship player, called directly."
        : "Benchmarking TypeSafe's System One model as a Battleship player, through Vercel AI Gateway."
      : "Benchmarking TypeSafe's System One model as a Battleship player.";
  }

  syncStrategyHints();
  setLayoutMode(layoutSelect.value, { startGame: false });
  strategySelect.addEventListener('change', syncStrategyHints);
  representationSelect.addEventListener('change', syncStrategyHints);
  el('layout-mode').addEventListener('change', (event) => setLayoutMode(event.target.value));
  el('seed').addEventListener('change', writeUrlState);
  el('copy-link').addEventListener('click', async () => {
    writeUrlState();
    try {
      await navigator.clipboard.writeText(window.location.href);
      el('copy-link').textContent = 'Copied';
      setTimeout(() => (el('copy-link').textContent = 'Copy link'), 1500);
    } catch {
      // Clipboard access can be refused; the URL bar already shows the link.
      el('copy-link').textContent = 'See URL bar';
      setTimeout(() => (el('copy-link').textContent = 'Copy link'), 1500);
    }
  });
  el('rotate').addEventListener('click', () => {
    state.placing.orientation =
      state.placing.orientation === 'horizontal' ? 'vertical' : 'horizontal';
    el('rotate').textContent = `Rotate: ${state.placing.orientation}`;
    if (state.placing.active) renderPlacement();
  });
  el('clear-fleet').addEventListener('click', () => {
    state.placing.placed.clear();
    state.placing.selectedShipId = state.config.defaultConfig.fleet[0].id;
    showError('');
    renderPlacement();
  });
  el('new-game').addEventListener('click', newGame);
  el('step').addEventListener('click', step);
  el('auto').addEventListener('click', toggleAuto);

  buildBoard(state.config.defaultConfig.rows, state.config.defaultConfig.cols);
  if (layoutSelect.value === 'manual') {
    setLayoutMode('manual');
  } else {
    await newGame();
  }
}

init().catch((error) => showError(error.message));
