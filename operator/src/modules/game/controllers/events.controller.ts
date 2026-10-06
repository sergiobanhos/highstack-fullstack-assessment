import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../../config';
import type { GameEventSubscription } from '../realtime/contracts';
import type { OperatorMessage } from '../realtime/round-state';

export const GAME_EVENTS_ROUTE = '/game/events';

export interface GameEventsControllerDeps {
  stream: Pick<GameStreamService, 'subscribe'>;
  logger: Logger;
}

interface GameStreamService {
  subscribe(): GameEventSubscription;
}

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function registerGameEventsRoute(app: FastifyInstance, deps: GameEventsControllerDeps): void {
  app.get(GAME_EVENTS_ROUTE, (_request, reply) => handleGameEvents(reply, deps));
}

/** Thin SSE boundary: write the synchronously captured snapshot, then activate messages. */
export function handleGameEvents(reply: FastifyReply, { stream, logger }: GameEventsControllerDeps): void {
  const subscription = stream.subscribe();
  const response = reply.raw;
  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    subscription.unsubscribe();
    logger.debug('game SSE client disconnected');
  };

  const write = (event: string, data: unknown): boolean => {
    if (closed) return false;
    if (response.destroyed) {
      cleanup();
      return false;
    }
    try {
      const accepted = response.write(frame(event, data));
      if (!accepted) {
        logger.warn('game SSE client backpressured; closing subscription');
        cleanup();
        response.end();
      }
      return accepted;
    } catch {
      cleanup();
      response.destroy();
      return false;
    }
  };

  reply.hijack();
  response.writeHead(200, SSE_HEADERS);
  response.once('close', cleanup);
  response.once('error', cleanup);
  reply.request.raw.once('close', cleanup);
  logger.debug('game SSE client connected');

  const snapshotMessage: OperatorMessage = {
    kind: 'snapshot',
    seq: subscription.snapshot.state.seq,
    state: subscription.snapshot.state,
    connection: subscription.snapshot.connection,
  };

  if (!write('snapshot', snapshotMessage)) return;

  subscription.activate((message) => {
    write(message.kind, message);
  });
}
