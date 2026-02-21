import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { join, resolve } from 'node:path';

export interface DashboardServerOptions {
  apiUrl: string;
  dashboardDir: string;
  port: number;
  host: string;
}

export async function startDashboardServer(opts: DashboardServerOptions): Promise<{ close: () => void }> {
  const distDir = resolve(opts.dashboardDir, 'dist');
  const indexHtmlPath = join(distDir, 'index.html');

  const app = new Hono();

  // Pass API URL to dashboard via environment variable
  app.use('*', async (c, next) => {
    c.header('X-Nacre-API-URL', opts.apiUrl);
    return next();
  });

  // Static assets
  app.use('/assets/*', serveStatic({ root: distDir }));

  // SPA fallback
  app.get('*', serveStatic({ path: indexHtmlPath }));

  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, (info) => {
    const hostLabel = opts.host === '0.0.0.0' ? 'localhost' : opts.host;
    console.log(`Dashboard running at http://${hostLabel}:${info.port}`);
    console.log(`API URL: ${opts.apiUrl}`);
  });

  return {
    close: () => {
      server.close();
    },
  };
}
