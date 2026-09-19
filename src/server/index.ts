import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectJevClient } from '../jev/direct.js';
import { GatewayJevClient } from '../jev/gateway.js';
import { MockJevClient } from '../jev/mock.js';
import type { JevClient } from '../jev/types.js';
import { ALL_STRATEGY_IDS, strategyUsesModel } from '../bench/strategies.js';
import { REPRESENTATIONS } from '../jev/representations.js';
import { validateFleet } from '../engine/placement.js';
import { makeConfig } from '../engine/config.js';
import { LAYOUT_DESCRIPTIONS, LAYOUT_FAMILIES, type LayoutFamily } from '../engine/layouts.js';
import type { PlacedShip } from '../engine/types.js';
import { rebuildFleet } from './fleetInput.js';
import { isMockEnabled } from './mockMode.js';
import { GameSession } from './gameSession.js';
import { loadEnv } from '../env.js';

loadEnv();

/**
 * Minimal server for the UI. It holds AI_GATEWAY_API_KEY and makes every Jev
 * call itself, so the key never reaches the browser.
 */

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 1_000_000;

/**
 * Transport selection. The direct TypeSafe API is preferred when a key is
 * present: it is markedly faster than the Gateway, reports the model version
 * that actually answered, and is not subject to the Gateway free tier's rate
 * limit. The Gateway is used when only that key is configured.
 */
/** Validates a layout family from an untrusted request body. */
function parseLayoutFamily(value: unknown): LayoutFamily {
  if (typeof value !== 'string') return 'random';
  // 'mixed' is a batch concept; a single game gets a concrete family.
  if (value === 'mixed' || !LAYOUT_FAMILIES.includes(value as LayoutFamily)) return 'random';
  return value as LayoutFamily;
}

function createLiveClient(): { client: JevClient; transport: 'direct' | 'gateway' } | undefined {
  if (process.env.TYPESAFE_API_KEY) {
    return {
      transport: 'direct',
      client: new DirectJevClient({
        maxLogEntries: 200,
        ...(process.env.TYPESAFE_DEFAULT_MODEL
          ? { model: process.env.TYPESAFE_DEFAULT_MODEL }
          : {}),
      }),
    };
  }

  if (process.env.AI_GATEWAY_API_KEY) {
    return {
      transport: 'gateway',
      client: new GatewayJevClient({
        // The Gateway free tier rate-limits this model, so pace and wait out a
        // 429 rather than failing the shot.
        minIntervalMs: Number(process.env.JEV_MIN_INTERVAL_MS ?? 1200),
        rateLimitRetries: 4,
        maxLogEntries: 200,
      }),
    };
  }

  return undefined;
}

const live = createLiveClient();
const liveClient = live?.client;
const hasApiKey = live !== undefined;
/**
 * Mock mode is a server-side switch, set with JEV_MOCK, never a request field.
 *
 * It replaces the model with code-side density, so it changes what the numbers
 * *mean* rather than what is being measured. Every other option here is a real
 * experimental dimension; this one is a "these are not results" flag, so it is
 * deliberately not something a page, a link or a stray click can turn on.
 */
const MOCK_MODE = isMockEnabled(process.env.JEV_MOCK);
const mockClient = new MockJevClient({ latencyMs: 120 });

const sessions = new Map<string, GameSession>();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body is not valid JSON');
  }
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  // Keep the resolved path inside the UI directory.
  const resolved = join(UI_DIR, normalize(relative));
  if (!resolved.startsWith(UI_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const file = await readFile(resolved);
    res.writeHead(200, { 'content-type': MIME[extname(resolved)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function pickClient(strategyId: string): JevClient {
  // Code-only strategies never call the client, so the mock is fine for them.
  if (!strategyUsesModel(strategyId)) return mockClient;
  if (MOCK_MODE) return mockClient;
  if (!liveClient) {
    throw new Error(
      'No Jev credentials on the server, so Jev strategies cannot run. Set TYPESAFE_API_KEY ' +
        '(preferred) or AI_GATEWAY_API_KEY and restart, or enable mock mode (results will ' +
        'not be real).',
    );
  }
  return liveClient;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      sendJson(res, 200, {
        strategies: ALL_STRATEGY_IDS.map((id) => ({ id, usesModel: strategyUsesModel(id) })),
        representations: REPRESENTATIONS.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
        })),
        liveClientAvailable: hasApiKey,
        transport: MOCK_MODE ? 'mock' : (live?.transport ?? 'none'),
        mockMode: MOCK_MODE,
        layoutFamilies: LAYOUT_FAMILIES.filter((f) => f !== 'mixed').map((id) => ({
          id,
          description: LAYOUT_DESCRIPTIONS[id],
        })),
        defaultConfig: makeConfig(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/games') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const strategyId = String(body.strategyId ?? 'density');
      if (!ALL_STRATEGY_IDS.includes(strategyId as never)) {
        sendJson(res, 400, { error: `Unknown strategy "${strategyId}"` });
        return;
      }

      const allowTouching = body.allowTouching !== false;

      // A player-supplied layout is rebuilt from its bow and orientation rather
      // than trusted: client-sent `cells` are ignored entirely, so a malformed
      // or hand-edited payload cannot reach the engine.
      let playerFleet: PlacedShip[] | undefined;
      if (Array.isArray(body.fleet)) {
        const config = makeConfig({ allowTouching });
        let rebuilt: PlacedShip[];
        try {
          rebuilt = rebuildFleet(body.fleet, config);
        } catch (error) {
          sendJson(res, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        const errors = validateFleet(rebuilt, config);
        if (errors.length > 0) {
          sendJson(res, 400, { error: `Invalid fleet layout: ${errors.join('; ')}` });
          return;
        }
        playerFleet = rebuilt;
      }

      const session = new GameSession({
        strategyId,
        representation: body.representation ? String(body.representation) : undefined,
        topK: body.topK ? Number(body.topK) : undefined,
        temperature: body.temperature !== undefined ? Number(body.temperature) : undefined,
        seed: body.seed !== undefined ? Number(body.seed) : undefined,
        allowTouching,
        fleet: playerFleet,
        layoutFamily: parseLayoutFamily(body.layoutFamily),
        client: pickClient(strategyId),
      });

      sessions.set(session.id, session);
      // Keep memory bounded when the page is reloaded repeatedly.
      if (sessions.size > 50) {
        const oldest = [...sessions.values()].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        )[0];
        if (oldest) sessions.delete(oldest.id);
      }

      sendJson(res, 201, session.snapshot());
      return;
    }

    const shotMatch = /^\/api\/games\/([\w-]+)\/shot$/.exec(url.pathname);
    if (req.method === 'POST' && shotMatch) {
      const session = sessions.get(shotMatch[1]!);
      if (!session) {
        sendJson(res, 404, { error: 'No such game' });
        return;
      }
      if (session.isOver) {
        sendJson(res, 409, { error: 'The game is already over', snapshot: session.snapshot() });
        return;
      }

      try {
        await session.step();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        session.recordError(message);
        sendJson(res, 502, { error: message, snapshot: session.snapshot() });
        return;
      }

      sendJson(res, 200, session.snapshot());
      return;
    }

    const gameMatch = /^\/api\/games\/([\w-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && gameMatch) {
      const session = sessions.get(gameMatch[1]!);
      if (!session) {
        sendJson(res, 404, { error: 'No such game' });
        return;
      }
      sendJson(res, 200, session.snapshot());
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

export { server };

// Only listen when run directly, so the module can be imported by tests.
const isEntryPoint = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntryPoint) {
  server.listen(PORT, () => {
    console.log(`Battleship vs. Jev running at http://localhost:${PORT}`);
    if (MOCK_MODE) {
      console.log(
        'JEV_MOCK is set: Jev strategies answer from code-side density. These are NOT results.',
      );
    }
    console.log(
      live?.transport === 'direct'
        ? `TypeSafe API key found: Jev strategies call TypeSafe directly${
            process.env.TYPESAFE_DEFAULT_MODEL ? ` (model ${process.env.TYPESAFE_DEFAULT_MODEL})` : ''
          }.`
        : live?.transport === 'gateway'
          ? 'AI Gateway key found: Jev strategies will make live Gateway calls.'
          : 'No Jev credentials: Jev strategies are unavailable. Code baselines and mock mode still work.',
    );
  });
}
