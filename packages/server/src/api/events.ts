import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@manga/shared';
import type { CoreDeps } from '../deps.js';

const WS_OPEN = 1;

/** WebSocket stream of ServerEvent JSON; the first message is always `hello`. */
export function registerEventRoutes(app: FastifyInstance, deps: CoreDeps): void {
  app.get('/api/events', { websocket: true }, (socket) => {
    const send = (event: ServerEvent): void => {
      if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(event));
    };
    send({ type: 'hello', serverTime: new Date().toISOString() });
    const off = deps.bus.on(send);
    socket.on('close', off);
    socket.on('error', off);
  });
}
