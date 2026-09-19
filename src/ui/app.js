/**
 * UI for Mode 1: a strategy hunts a fixed fleet.
 * All Jev calls happen on the server, which holds the API key.
 */

const LETTERS = 'ABCDEFGHIJ';
const el = (id) => document.getElementById(id);

const state = {
  config: null,
  game: null,
  autoPlaying: false,
  abort: false,
};

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

      // Heat shading only where nothing is known yet.
      const heat = value === 'unknown' && heatmap ? heatmap[row][col] : 0;
      if (heat > 0) {
        node.dataset.heat = 'true';
        node.style.setProperty('--heat-alpha', String(Math.min(heat, 1) * 0.85));
      } else {
        delete node.dataset.heat;
        node.style.removeProperty('--heat-alpha');
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

  const confidences = game.history.map((h) => h.confidence).filter((c) => typeof c === 'number');
  el('m-confidence').textContent = confidences.length
    ? (confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(2)
    : '-';

  el('m-model').textContent = game.modelIds.length
    ? `Model: ${game.modelIds.join(', ')}`
    : 'Model: not a model call';

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
    mock: el('mock').checked,
  };

  try {
    const game = await api('/api/games', { method: 'POST', body: JSON.stringify(body) });
    buildBoard(game.config.rows, game.config.cols);
    render(game);
  } catch (error) {
    showError(error.message);
  }
}

async function step() {
  if (!state.game || state.game.isOver) return false;
  try {
    const game = await api(`/api/games/${state.game.id}/shot`, { method: 'POST' });
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
  const usesModel = state.config.strategies.find((s) => s.id === strategyId)?.usesModel ?? false;

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

  const status = el('client-status');
  if (state.config.liveClientAvailable) {
    status.textContent = 'Gateway key present: Jev strategies are live';
    status.classList.add('live');
  } else {
    status.textContent = 'No AI_GATEWAY_API_KEY: Jev strategies unavailable';
    status.classList.add('offline');
    el('mock').checked = true;
  }

  syncStrategyHints();
  strategySelect.addEventListener('change', syncStrategyHints);
  representationSelect.addEventListener('change', syncStrategyHints);
  el('new-game').addEventListener('click', newGame);
  el('step').addEventListener('click', step);
  el('auto').addEventListener('click', toggleAuto);

  buildBoard(state.config.defaultConfig.rows, state.config.defaultConfig.cols);
  await newGame();
}

init().catch((error) => showError(error.message));
