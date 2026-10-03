import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../../config';
import { GameEventHub } from './game-event-hub';
import type { GameStreamService } from './game-stream.service';
import type { OperatorMessage } from './round-state';

export const GAME_EVENTS_ROUTE = '/game/events';

export interface GameEventsControllerDeps {
  hub: GameEventHub;
  stream: GameStreamService;
  logger: Logger;
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

/** Thin SSE boundary: capture the state synchronously, then stream hub messages. */
export function handleGameEvents(reply: FastifyReply, { hub, stream, logger }: GameEventsControllerDeps): void {
  const subscription = hub.subscribeWithSnapshot(() => stream.getSnapshot());
  const response = reply.raw;
  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    subscription.unsubscribe();
    logger.debug('game SSE client disconnected', { subscribers: hub.subscriberCount });
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
  logger.debug('game SSE client connected', { subscribers: hub.subscriberCount });

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
