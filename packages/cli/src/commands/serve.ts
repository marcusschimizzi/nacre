import { existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { defineCommand } from 'citty';
import { fileURLToPath } from 'node:url';
import { loadGraph, closeGraph } from '../graph-loader.js';

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
    description: 'Launch the 3D graph visualization',
  },
  args: {
    graph: {
      type: 'string',
      description: 'Path to graph (.db or .json)',
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
    const graphPath = args.graph as string;
    const vizDir = findVizDir();
    const dest = resolve(vizDir, 'public', 'graph.json');

    // Load graph (supports both .db and .json)
    const loaded = await loadGraph(graphPath);
    try {
      if (loaded.format === 'sqlite') {
        // Export SQLite graph to JSON for the viz
        writeFileSync(dest, JSON.stringify(loaded.graph, null, 2), 'utf8');
        console.log(`Exported SQLite graph → ${dest}`);
      } else {
        // Copy JSON directly
        const srcPath = resolve(graphPath);
        if (srcPath !== dest) {
          copyFileSync(srcPath, dest);
          console.log(`Copied ${srcPath} → ${dest}`);
        }
      }
    } finally {
      closeGraph(loaded);
    }

    const port = args.port as string;
    const openFlag = args.open ? '--open' : '';

    console.log(`Starting viz at http://localhost:${port}`);
    execSync(`npx vite --port ${port} ${openFlag}`.trim(), {
      cwd: vizDir,
      stdio: 'inherit',
    });
  },
});
