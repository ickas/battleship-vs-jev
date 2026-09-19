import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayJevClient } from '../jev/gateway.js';
import { MockJevClient } from '../jev/mock.js';
import type { JevClient } from '../jev/types.js';
import { ALL_STRATEGY_IDS, strategyUsesModel } from '../bench/strategies.js';
import { REPRESENTATIONS } from '../jev/representations.js';
import { validateFleet } from '../engine/placement.js';
import { makeConfig } from '../engine/config.js';
import type { PlacedShip } from '../engine/types.js';
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

const hasApiKey = Boolean(process.env.AI_GATEWAY_API_KEY);
const liveClient: JevClient | undefined = hasApiKey ? new GatewayJevClient() : undefined;
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

function pickClient(strategyId: string, useMock: boolean): JevClient {
  if (!strategyUsesModel(strategyId)) return mockClient;
  if (useMock) return mockClient;
  if (!liveClient) {
    throw new Error(
      'AI_GATEWAY_API_KEY is not set on the server, so Jev strategies cannot run. ' +
        'Set it and restart, or enable mock mode (results will not be real).',
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

      // A player-supplied layout must pass the same validation as any other.
      let playerFleet: PlacedShip[] | undefined;
      if (Array.isArray(body.fleet)) {
        const errors = validateFleet(body.fleet as PlacedShip[], makeConfig({ allowTouching }));
        if (errors.length > 0) {
          sendJson(res, 400, { error: `Invalid fleet layout: ${errors.join('; ')}` });
          return;
        }
        playerFleet = body.fleet as PlacedShip[];
      }

      const session = new GameSession({
        strategyId,
        representation: body.representation ? String(body.representation) : undefined,
        topK: body.topK ? Number(body.topK) : undefined,
        temperature: body.temperature !== undefined ? Number(body.temperature) : undefined,
        seed: body.seed !== undefined ? Number(body.seed) : undefined,
        allowTouching,
        fleet: playerFleet,
        client: pickClient(strategyId, body.mock === true),
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

server.listen(PORT, () => {
  console.log(`Battleship vs. Jev running at http://localhost:${PORT}`);
  console.log(
    hasApiKey
      ? 'AI_GATEWAY_API_KEY found: Jev strategies will make live Gateway calls.'
      : 'AI_GATEWAY_API_KEY not set: Jev strategies are unavailable. Code baselines and mock mode still work.',
  );
});
