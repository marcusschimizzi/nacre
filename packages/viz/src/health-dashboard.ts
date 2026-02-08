import type { ForceNode, ForceLink } from './types.ts';
import type { GraphApiClient, GraphStats } from './api-client.ts';

export interface HealthMetrics {
  nodeCount: number;
  edgeCount: number;
  graphDensity: number;
  avgWeight: number;
  embeddingCount: number;
  lastConsolidated: string;
  decayRate: number;
  nodesByType: Record<string, number>;
  reinforcementFrequency: number[];
  memoryAgeDistribution: number[];
}

/**
 * HealthDashboard - Displays memory health metrics in a collapsible sidebar.
 */
export class HealthDashboard {
  private container: HTMLElement;
  private apiClient: GraphApiClient;
  private collapsed: boolean = false;
  private refreshInterval: number | null = null;

  constructor(container: HTMLElement, apiClient: GraphApiClient) {
    this.container = container;
    this.apiClient = apiClient;
    this.render();
  }

  /**
   * Toggle the collapsed state of the dashboard
   */
  toggle(): void {
    this.collapsed = !this.collapsed;
    this.updateCollapsedState();
  }

  private updateCollapsedState(): void {
    const content = this.container.querySelector('.health-dashboard-content') as HTMLElement;
    const toggleBtn = this.container.querySelector('.health-dashboard-toggle') as HTMLElement;

    if (content) {
      content.style.display = this.collapsed ? 'none' : 'block';
    }
    if (toggleBtn) {
      toggleBtn.textContent = this.collapsed ? '◀' : '▶';
    }
  }

  /**
   * Fetch latest metrics from API
   */
  async refreshMetrics(): Promise<void> {
    try {
      const stats = await this.apiClient.fetchStats();
      this.renderMetrics(stats);
    } catch (e) {
      console.error('[HealthDashboard] Failed to refresh metrics:', e);
    }
  }

  /**
   * Start auto-refreshing metrics every 30 seconds
   */
  startAutoRefresh(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = window.setInterval(() => {
      this.refreshMetrics();
    }, 30000);
  }

  /**
   * Stop auto-refreshing
   */
  stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /**
   * Initialize the dashboard UI
   */
  private render(): void {
    this.container.innerHTML = `
      <div class="health-dashboard">
        <div class="health-dashboard-header">
          <h3>Memory Health</h3>
          <button class="health-dashboard-toggle" title="Toggle panel">▶</button>
          <button class="health-dashboard-refresh" title="Refresh">⟳</button>
        </div>
        <div class="health-dashboard-content">
          <div id="health-metrics"></div>
        </div>
      </div>
    `;

    // Add event listeners
    const toggleBtn = this.container.querySelector('.health-dashboard-toggle') as HTMLElement;
    toggleBtn?.addEventListener('click', () => this.toggle());

    const refreshBtn = this.container.querySelector('.health-dashboard-refresh') as HTMLElement;
    refreshBtn?.addEventListener('click', () => this.refreshMetrics());

    // Initial metrics fetch
    this.refreshMetrics().catch(console.error);
  }

  /**
   * Render metrics from stats
   */
  private renderMetrics(stats: GraphStats): void {
    const metricsDiv = this.container.querySelector('#health-metrics') as HTMLElement;
    if (!metricsDiv) return;

    // Calculate graph density
    const graphDensity = stats.nodeCount > 1
      ? stats.edgeCount / (stats.nodeCount * (stats.nodeCount - 1) / 2)
      : 0;

    const lastConsolidated = new Date(stats.lastConsolidated);
    const now = new Date();
    const daysSinceConsolidation = Math.floor((now.getTime() - lastConsolidated.getTime()) / (1000 * 60 * 60 * 24));

    metricsDiv.innerHTML = `
      ${this.renderMetricCard('Nodes', stats.nodeCount.toLocaleString())}
      ${this.renderMetricCard('Edges', stats.edgeCount.toLocaleString())}
      ${this.renderMetricCard('Graph Density', (graphDensity * 100).toFixed(2) + '%', this.getDensityColor(graphDensity))}
      ${this.renderMetricCard('Avg Weight', stats.avgWeight.toFixed(2))}
      ${this.renderMetricCard('Embeddings', stats.embeddingCount.toLocaleString())}
      ${this.renderMetricCard(
        'Last Consolidated',
        daysSinceConsolidation === 0 ? 'Today' : `${daysSinceConsolidation}d ago`,
        this.getConsolidationColor(daysSinceConsolidation)
      )}
      ${this.renderNodesByType(stats.nodesByType)}
    `;
  }

  /**
   * Render a simple metric card
   */
  private renderMetricCard(label: string, value: string, color?: string): string {
    const valueStyle = color ? `color: ${color};` : '';
    return `
      <div class="metric-card">
        <div class="metric-label">${label}</div>
        <div class="metric-value" style="${valueStyle}">${value}</div>
      </div>
    `;
  }

  /**
   * Render nodes by type as a simple bar chart
   */
  private renderNodesByType(nodesByType: Record<string, number>): string {
    const entries = Object.entries(nodesByType).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, [, count]) => sum + count, 0);

    const bars = entries.map(([type, count]) => {
      const percentage = (count / total) * 100;
      return `
        <div class="type-bar-row">
          <div class="type-label">${type}</div>
          <div class="type-bar-container">
            <div class="type-bar" style="width: ${percentage}%"></div>
          </div>
          <div class="type-count">${count}</div>
        </div>
      `;
    }).join('');

    return `
      <div class="metric-section">
        <div class="metric-section-title">Nodes by Type</div>
        <div class="type-chart">
          ${bars}
        </div>
      </div>
    `;
  }

  /**
   * Get color based on graph density
   */
  private getDensityColor(density: number): string {
    if (density < 0.01) return '#f59e0b'; // Low density - yellow
    if (density < 0.05) return '#10b981'; // Healthy - green
    if (density < 0.1) return '#8b5cf6'; // High - purple
    return '#ef4444'; // Very high - red
  }

  /**
   * Get color based on consolidation age
   */
  private getConsolidationColor(days: number): string {
    if (days === 0) return '#10b981'; // Today - green
    if (days < 7) return '#8b5cf6'; // This week - purple
    if (days < 30) return '#f59e0b'; // This month - yellow
    return '#ef4444'; // Old - red
  }

  /**
   * Calculate metrics from loaded graph data (fallback when API unavailable)
   */
  static calculateMetrics(nodes: ForceNode[], links: ForceLink[], config: { decayRate: number }): HealthMetrics {
    const nodeCount = nodes.length;
    const edgeCount = links.length;

    // Calculate graph density
    const graphDensity = nodeCount > 1
      ? edgeCount / (nodeCount * (nodeCount - 1) / 2)
      : 0;

    // Calculate average weight
    const totalWeight = links.reduce((sum, link) => sum + link.weight, 0);
    const avgWeight = edgeCount > 0 ? totalWeight / edgeCount : 0;

    // Nodes by type
    const nodesByType: Record<string, number> = {};
    for (const node of nodes) {
      nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
    }

    // Reinforcement frequency histogram (10 buckets)
    const maxReinforcement = Math.max(...nodes.map(n => n.reinforcementCount), 1);
    const reinforcementFrequency = new Array(10).fill(0);
    for (const node of nodes) {
      const bucket = Math.min(Math.floor((node.reinforcementCount / maxReinforcement) * 10), 9);
      reinforcementFrequency[bucket]++;
    }

    // Memory age distribution (10 buckets based on firstSeen)
    const now = new Date();
    const timestamps = nodes.map(n => new Date(n.firstSeen).getTime()).sort((a, b) => a - b);
    const minTime = timestamps[0] ?? now.getTime();
    const maxTime = timestamps[timestamps.length - 1] ?? now.getTime();
    const timeRange = maxTime - minTime || 1;

    const memoryAgeDistribution = new Array(10).fill(0);
    for (const timestamp of timestamps) {
      const normalized = (timestamp - minTime) / timeRange;
      const bucket = Math.min(Math.floor(normalized * 10), 9);
      memoryAgeDistribution[bucket]++;
    }

    return {
      nodeCount,
      edgeCount,
      graphDensity,
      avgWeight,
      embeddingCount: 0, // Not available in static data
      lastConsolidated: '', // Not available in static data
      decayRate: config.decayRate,
      nodesByType,
      reinforcementFrequency,
      memoryAgeDistribution,
    };
  }
}
