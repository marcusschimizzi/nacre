import { defineCommand } from 'citty';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDashboardServer } from '../viz/dashboard-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineCommand({
  meta: {
    name: 'dashboard',
    description: 'Launch React memory dashboard',
  },
  args: {
    port: {
      type: 'string',
      description: 'Dashboard server port',
      default: '5174',
    },
    host: {
      type: 'string',
      description: 'Dashboard server host',
      default: '0.0.0.0',
    },
    apiPort: {
      type: 'string',
      description: 'Nacre API port (dashboard connects to API on this port)',
      default: '3200',
    },
    apiHost: {
      type: 'string',
      description: 'Nacre API host',
      default: '0.0.0.0',
    },
  },
  async run({ args }) {
    const port = parseInt(args.port as string, 10) || 5174;
    const host = args.host as string || '0.0.0.0';
    const apiPort = parseInt(args.apiPort as string, 10) || 3200;
    let apiHost = args.apiHost as string || undefined;

    // Use localhost as default, not '0.0.0.0'
    if (apiHost === undefined || apiHost === '0.0.0.0' || apiHost === 'localhost') {
      apiHost = 'localhost';
    }

    const { close } = startDashboardServer({
      apiUrl: `http://${apiHost}:${apiPort}`,
      dashboardDir: resolve(__dirname, '..', '..', 'dashboard'),
      port,
      host,
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nShutting down dashboard...');
      close();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\nShutting down dashboard...');
      close();
      process.exit(0);
    });
  },
});
