import { existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { defineCommand } from 'citty';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findVizDir(): string {
  const fromSrc = resolve(__dirname, '..', '..', '..', 'viz');
  if (existsSync(resolve(fromSrc, 'index.html'))) return fromSrc;

  const fromDist = resolve(__dirname, '..', '..', '..', '..', 'viz');
  if (existsSync(resolve(fromDist, 'index.html'))) return fromDist;

  throw new Error(
    'Could not find @nacre/viz package. Expected sibling directory in packages/',
  );
}

export default defineCommand({
  meta: {
    name: 'serve',
    description: 'Launch the 3D graph visualization with a graph.json file',
  },
  args: {
    graph: {
      type: 'string',
      description: 'Path to graph.json',
      default: 'data/graphs/default/graph.json',
    },
    port: {
      type: 'string',
      description: 'Dev server port',
      default: '5173',
    },
    open: {
      type: 'boolean',
      description: 'Open browser automatically',
      default: true,
    },
  },
  async run({ args }) {
    const graphPath = resolve(args.graph as string);

    if (!existsSync(graphPath)) {
      console.error(`Graph not found: ${graphPath}`);
      console.error('Run "nacre consolidate <source>" first to generate a graph.');
      process.exit(1);
    }

    const vizDir = findVizDir();
    const dest = resolve(vizDir, 'public', 'graph.json');

    copyFileSync(graphPath, dest);
    console.log(`Copied ${graphPath} → ${dest}`);

    const port = args.port as string;
    const openFlag = args.open ? '--open' : '';

    console.log(`Starting viz at http://localhost:${port}`);
    execSync(`npx vite --port ${port} ${openFlag}`.trim(), {
      cwd: vizDir,
      stdio: 'inherit',
    });
  },
});
