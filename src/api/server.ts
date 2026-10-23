import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** Listen on `port` (0 picks a free one) and resolve once the socket is bound. */
export function startServer(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  port: number,
  hostname: string,
): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info: AddressInfo) => {
      resolve({
        port: info.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
            // Streamable HTTP responses can hold sockets open; don't let them block shutdown.
            if ('closeAllConnections' in server) server.closeAllConnections();
          }),
      });
    });
    server.once('error', reject);
  });
}
