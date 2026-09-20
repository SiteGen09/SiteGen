'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PROVIDER_LABELS } from '@/lib/ai/providers';
import type { ChannelInfo, LedgerRow, UsageEventRow } from '@/lib/dashboard/queries';
import { formatCredits, formatTimestamp } from '../ui';

const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '60d', label: '60D' },
] as const;

type Period = (typeof PERIODS)[number]['value'];
type Tab = 'overview' | 'details';
type ChartMode = 'tokens' | 'cost';

interface UsageDashboardProps {
  events: UsageEventRow[];
  ledgerPage: LedgerRow[];
  channels: ChannelInfo[];
  from?: string;
  to?: string;
  status?: string;
  cursor?: number;
  nextCursor: number | null;
  ledgerNewestHref: string;
  ledgerOlderHref: string | null;
  renderedAt: number;
  initialTab: Tab;
}

interface TrendPoint {
  label: string;
  tokens: number;
  cost: number;
}

interface TopologyPosition {
  x: number;
  y: number;
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');
const CURRENCY_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
});
const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const HOUR_LABEL_FORMAT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  hour12: false,
  timeZone: 'UTC',
});
const DAY_LABEL_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const TOPOLOGY_POSITIONS: TopologyPosition[] = [
  { x: 105, y: 48 },
  { x: 300, y: 38 },
  { x: 510, y: 52 },
  { x: 650, y: 115 },
  { x: 635, y: 305 },
  { x: 470, y: 370 },
  { x: 245, y: 372 },
  { x: 70, y: 300 },
];

function number(value: number): string {
  return NUMBER_FORMAT.format(Math.max(0, Math.round(value)));
}

function currency(value: number): string {
  return CURRENCY_FORMAT.format(Math.max(0, value));
}

function compact(value: number): string {
  return COMPACT_NUMBER_FORMAT.format(Math.max(0, value));
}

function eventTokens(event: UsageEventRow): number {
  return (event.input_tokens ?? 0) + (event.cached_tokens ?? 0) + (event.output_tokens ?? 0);
}

function eventCost(event: UsageEventRow): number {
  return event.cost_usd ?? 0;
}

function periodStart(period: Period, now: number): number {
  if (period === 'today') {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }
  if (period === '24h') return now - 24 * 60 * 60 * 1000;
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 60;
  const date = new Date(now);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return today - (days - 1) * 24 * 60 * 60 * 1000;
}

function relativeTime(value: string, now: number): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function providerColor(provider: ChannelInfo['provider'], index: number): string {
  if (provider === 'anthropic') return 'var(--usage-orange)';
  if (provider === 'anthropic_compatible') return 'var(--usage-purple)';
  if (provider === 'openai_compatible') return 'var(--usage-blue)';
  return (
    ['var(--usage-purple)', 'var(--usage-green)', 'var(--usage-yellow)'][index % 3] ??
    'var(--usage-purple)'
  );
}

function providerShortName(provider: ChannelInfo['provider']): string {
  return PROVIDER_LABELS[provider];
}

function statusClass(status: string): string {
  if (status === 'ok' || status === 'active' || status === 'settle') return 'usage-status-ok';
  if (status === 'failed' || status === 'revoked') return 'usage-status-failed';
  if (status === 'rejected' || status === 'hold' || status === 'release') {
    return 'usage-status-warn';
  }
  return 'usage-status-muted';
}

function channelName(channelId: string, map: Map<string, ChannelInfo>): string {
  return map.get(channelId)?.label ?? channelId;
}

function buildTrend(events: UsageEventRow[], period: Period, now: number): TrendPoint[] {
  const hourly = period === 'today' || period === '24h';
  const count = hourly ? 24 : period === '7d' ? 7 : period === '30d' ? 30 : 60;
  const bucketMs = hourly ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const start = periodStart(period, now);
  const points: TrendPoint[] = Array.from({ length: count }, (_, index) => {
    const timestamp = start + index * bucketMs;
    return {
      label: hourly ? HOUR_LABEL_FORMAT.format(new Date(timestamp)) : DAY_LABEL_FORMAT.format(new Date(timestamp)),
      tokens: 0,
      cost: 0,
    };
  });

  for (const event of events) {
    const timestamp = new Date(event.created_at).getTime();
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > now) continue;
    const index = Math.min(count - 1, Math.max(0, Math.floor((timestamp - start) / bucketMs)));
    const point = points[index];
    if (point === undefined) continue;
    point.tokens += eventTokens(event);
    point.cost += eventCost(event);
  }

  return points;
}

function topologyPath(position: TopologyPosition): string {
  const controlX = (360 + position.x) / 2;
  return `M 360 210 C ${controlX} ${210}, ${controlX} ${position.y}, ${position.x} ${position.y}`;
}

function KpiCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent: string;
}) {
  return (
    <article className="usage-kpi-card">
      <div className="usage-kpi-label">
        <span className={`usage-kpi-dot ${accent}`} aria-hidden="true" />
        {label}
      </div>
      <p className={`usage-kpi-value ${accent}`}>{value}</p>
      {hint !== undefined && <p className="usage-kpi-hint">{hint}</p>}
    </article>
  );
}

function OverviewHeader({
  activeTab,
  period,
  onTabChange,
  onPeriodChange,
}: {
  activeTab: Tab;
  period: Period;
  onTabChange: (tab: Tab) => void;
  onPeriodChange: (period: Period) => void;
}) {
  return (
    <div className="usage-controls-row">
      <div className="usage-segmented" aria-label="Usage view">
        <button
          type="button"
          className={activeTab === 'overview' ? 'is-active' : ''}
          aria-pressed={activeTab === 'overview'}
          onClick={() => onTabChange('overview')}
        >
          Overview
        </button>
        <button
          type="button"
          className={activeTab === 'details' ? 'is-active' : ''}
          aria-pressed={activeTab === 'details'}
          onClick={() => onTabChange('details')}
        >
          Details
        </button>
      </div>

      {activeTab === 'overview' && (
        <div className="usage-periods" aria-label="Usage period">
          {PERIODS.map((item) => (
            <button
              type="button"
              key={item.value}
              className={period === item.value ? 'is-active' : ''}
              aria-pressed={period === item.value}
              onClick={() => onPeriodChange(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderTopology({
  channels,
  events,
  channelMap,
}: {
  channels: ChannelInfo[];
  events: UsageEventRow[];
  channelMap: Map<string, ChannelInfo>;
}) {
  const latestChannel = events[0]?.channel_id;
  const providers = useMemo(() => {
    const observed = new Map<string, number>();
    for (const event of events) observed.set(event.channel_id, (observed.get(event.channel_id) ?? 0) + 1);

    const observedIds = new Set(observed.keys());
    const all = channels.filter((channel) => observedIds.has(channel.id));
    for (const event of events) {
      if (!channelMap.has(event.channel_id)) {
        all.push({
          id: event.channel_id,
          label: event.channel_id,
          task: 'site.spec',
          provider: 'openai_compatible',
          model_id: event.channel_id,
          status: 'observed',
        });
      }
    }

    const seen = new Set<string>();
    return all
      .filter((channel) => {
        if (seen.has(channel.id)) return false;
        seen.add(channel.id);
        return true;
      })
      .sort((a, b) => (observed.get(b.id) ?? 0) - (observed.get(a.id) ?? 0))
      .slice(0, TOPOLOGY_POSITIONS.length);
  }, [channelMap, channels, events]);

  return (
    <div className={`usage-topology-canvas${providers.length === 0 ? ' is-empty' : ''}`}>
      <svg viewBox="0 0 720 420" role="img" aria-label="sitegen routing topology">
        <defs>
          <linearGradient id="usage-route-line" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--usage-orange)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--usage-blue)" stopOpacity="0.3" />
          </linearGradient>
        </defs>

        {providers.map((provider, index) => {
          const position = TOPOLOGY_POSITIONS[index];
          if (position === undefined) return null;
          const color = providerColor(provider.provider, index);
          const count = events.filter((event) => event.channel_id === provider.id).length;
          const selected = provider.id === latestChannel;
          const label = provider.label.length > 23 ? `${provider.label.slice(0, 22)}…` : provider.label;
          const model = provider.model_id.length > 27 ? `${provider.model_id.slice(0, 26)}…` : provider.model_id;

          return (
            <g key={provider.id}>
              <title>
                {provider.label} · {provider.model_id} · {providerShortName(provider.provider)}
              </title>
              <path
                d={topologyPath(position)}
                fill="none"
                stroke={selected ? 'url(#usage-route-line)' : 'var(--usage-line)'}
                strokeWidth={selected ? 2.5 : 1.25}
                strokeOpacity={selected ? 0.95 : 0.68}
                strokeDasharray={selected ? undefined : '4 5'}
              />
              <g transform={`translate(${position.x - 90} ${position.y - 29})`}>
                <rect
                  width="180"
                  height="58"
                  rx="9"
                  fill="var(--usage-surface)"
                  stroke={selected ? color : 'var(--usage-node-border)'}
                  strokeWidth={selected ? 1.8 : 1}
                />
                <circle cx="19" cy="20" r="9" fill={`color-mix(in srgb, ${color} 16%, transparent)`} />
                <text x="19" y="24" textAnchor="middle" fill={color} fontSize="9" fontWeight="700">
                  {provider.provider === 'anthropic' ? 'AN' : 'OP'}
                </text>
                <text x="36" y="21" fill="var(--usage-text)" fontSize="11" fontWeight="600">
                  {label}
                </text>
                <text x="36" y="40" fill="var(--usage-muted)" fontSize="9">
                  {model}
                </text>
                {count > 0 && (
                  <text x="164" y="21" textAnchor="end" fill={color} fontSize="10" fontWeight="700">
                    {count}
                  </text>
                )}
              </g>
            </g>
          );
        })}

        <g transform="translate(285 178)">
          <rect
            width="150"
            height="64"
            rx="12"
            fill="var(--usage-orange-wash)"
            stroke="var(--usage-orange)"
            strokeWidth="1.8"
          />
          <rect x="13" y="16" width="31" height="31" rx="8" fill="var(--usage-orange)" />
          <path d="M22 38V25h4v9h4v-13h4v17h-4v4h-8Z" fill="#ffffff" />
          <text x="56" y="29" fill="var(--usage-orange-strong)" fontSize="14" fontWeight="700">
            sitegen
          </text>
          <text x="56" y="45" fill="var(--usage-muted)" fontSize="9">
            routing layer
          </text>
        </g>
      </svg>

      <div className="usage-topology-caption">
        <span className="usage-live-dot" aria-hidden="true" />
        {latestChannel === undefined
          ? 'No requests in the selected period'
          : `Last request routed through ${channelName(latestChannel, channelMap)}`}
      </div>
    </div>
  );
}

function RecentRequests({
  events,
  channelMap,
  renderedAt,
}: {
  events: UsageEventRow[];
  channelMap: Map<string, ChannelInfo>;
  renderedAt: number;
}) {
  return (
    <section className="usage-card usage-recent-card">
      <div className="usage-card-heading">
        <div>
          <p className="usage-card-eyebrow">Recent requests</p>
          <h2>Latest generation activity</h2>
        </div>
        <span className="usage-card-count">{events.length}</span>
      </div>
      {events.length === 0 ? (
        <div className="usage-empty-state">No requests in this period.</div>
      ) : (
        <div className="usage-recent-list">
          {events.slice(0, 14).map((event) => {
            const successful = event.status === 'ok';
            return (
              <div className="usage-recent-row" key={event.request_id}>
                <span
                  className={`usage-request-dot ${successful ? 'is-success' : 'is-error'}`}
                  aria-label={event.status}
                />
                <div className="usage-recent-model">
                  <strong>{channelName(event.channel_id, channelMap)}</strong>
                  <span>{event.request_id.slice(0, 13)}…</span>
                </div>
                <div className="usage-recent-tokens">
                  <span>{number(event.input_tokens ?? 0)}↑</span>
                  <span>{number(event.output_tokens ?? 0)}↓</span>
                </div>
                <time dateTime={event.created_at}>{relativeTime(event.created_at, renderedAt)}</time>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TrendChart({ events, period, renderedAt }: { events: UsageEventRow[]; period: Period; renderedAt: number }) {
  const [mode, setMode] = useState<ChartMode>('tokens');
  const points = useMemo(() => buildTrend(events, period, renderedAt), [events, period, renderedAt]);
  const values = points.map((point) => (mode === 'tokens' ? point.tokens : point.cost));
  const max = Math.max(...values, 1);
  const width = 1000;
  const height = 260;
  const left = 44;
  const right = 18;
  const top = 18;
  const bottom = 36;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const step = points.length > 1 ? chartWidth / (points.length - 1) : chartWidth;
  const coordinates = values.map((value, index) => ({
    x: left + index * step,
    y: top + chartHeight - (value / max) * chartHeight,
  }));
  const linePath = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const areaPath = `${linePath} L ${left + (points.length - 1) * step} ${top + chartHeight} L ${left} ${top + chartHeight} Z`;
  const hasData = values.some((value) => value > 0);

  return (
    <section className="usage-card usage-trend-card">
      <div className="usage-card-heading usage-trend-heading">
        <div>
          <p className="usage-card-eyebrow">Activity trend</p>
          <h2>Usage over time</h2>
        </div>
        <div className="usage-segmented usage-chart-toggle" aria-label="Chart metric">
          <button
            type="button"
            className={mode === 'tokens' ? 'is-active' : ''}
            aria-pressed={mode === 'tokens'}
            onClick={() => setMode('tokens')}
          >
            Tokens
          </button>
          <button
            type="button"
            className={mode === 'cost' ? 'is-active' : ''}
            aria-pressed={mode === 'cost'}
            onClick={() => setMode('cost')}
          >
            Cost
          </button>
        </div>
      </div>
      <div className="usage-chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${mode} usage trend`}>
          <defs>
            <linearGradient id="usage-chart-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={mode === 'tokens' ? 'var(--usage-orange)' : 'var(--usage-yellow)'} stopOpacity="0.28" />
              <stop offset="100%" stopColor={mode === 'tokens' ? 'var(--usage-orange)' : 'var(--usage-yellow)'} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3].map((line) => {
            const y = top + (chartHeight / 3) * line;
            return <line key={line} x1={left} x2={width - right} y1={y} y2={y} className="usage-chart-grid" />;
          })}
          <text x="4" y={top + 4} className="usage-chart-axis">
            {mode === 'tokens' ? compact(max) : currency(max)}
          </text>
          <text x="4" y={top + chartHeight + 4} className="usage-chart-axis">
            0
          </text>
          {hasData && <path d={areaPath} fill="url(#usage-chart-fill)" />}
          <path d={hasData ? linePath : `M ${left} ${top + chartHeight} L ${width - right} ${top + chartHeight}`} className={`usage-chart-line ${mode}`} />
          {hasData &&
            coordinates.map((point, index) => (
              <circle key={index} cx={point.x} cy={point.y} r="3.5" className={`usage-chart-point ${mode}`}>
                <title>
                  {points[index]?.label}: {mode === 'tokens' ? number(points[index]?.tokens ?? 0) : currency(points[index]?.cost ?? 0)}
                </title>
              </circle>
            ))}
          {points.map((point, index) => {
            const show = points.length <= 12 || index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 6) === 0;
            if (!show) return null;
            return (
              <text key={`${point.label}-${index}`} x={left + index * step} y={height - 8} textAnchor="middle" className="usage-chart-label">
                {point.label}
              </text>
            );
          })}
        </svg>
        {!hasData && <div className="usage-chart-empty">No {mode} recorded in this period.</div>}
      </div>
    </section>
  );
}

function DetailsView({
  events,
  ledgerPage,
  channelMap,
  from,
  to,
  status,
  cursor,
  nextCursor,
  ledgerNewestHref,
  ledgerOlderHref,
  onOverview,
}: {
  events: UsageEventRow[];
  ledgerPage: LedgerRow[];
  channelMap: Map<string, ChannelInfo>;
  from?: string;
  to?: string;
  status?: string;
  cursor?: number;
  nextCursor: number | null;
  ledgerNewestHref: string;
  ledgerOlderHref: string | null;
  onOverview: () => void;
}) {
  return (
    <div className="usage-details-view">
      <div className="usage-card usage-filter-card">
        <div>
          <p className="usage-card-eyebrow">Request explorer</p>
          <h2>Filter generation activity</h2>
        </div>
        <form method="get" action="/dashboard/usage" className="usage-filter-form">
          <input type="hidden" name="tab" value="details" />
          <label>
            From
            <input name="from" type="date" defaultValue={from ?? ''} />
          </label>
          <label>
            To
            <input name="to" type="date" defaultValue={to ?? ''} />
          </label>
          <label>
            Status
            <select name="status" defaultValue={status ?? ''}>
              <option value="">All statuses</option>
              <option value="ok">ok</option>
              <option value="failed">failed</option>
              <option value="rejected">rejected</option>
            </select>
          </label>
          <button type="submit" className="usage-primary-button">
            Apply filters
          </button>
          <Link href="/dashboard/usage?tab=details" className="usage-muted-button">
            Reset
          </Link>
        </form>
      </div>

      <section className="usage-card usage-details-card">
        <div className="usage-card-heading">
          <div>
            <p className="usage-card-eyebrow">Request log</p>
            <h2>{number(events.length)} recorded requests</h2>
          </div>
          <button type="button" className="usage-muted-button" onClick={onOverview}>
            Back to overview
          </button>
        </div>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th>Request</th>
                <th>Channel / model</th>
                <th>Input</th>
                <th>Cached</th>
                <th>Output</th>
                <th>Latency</th>
                <th>Status</th>
                <th>Credits</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr>
                  <td colSpan={9} className="usage-table-empty">
                    No requests match these filters.
                  </td>
                </tr>
              ) : (
                events.map((event) => {
                  const channel = channelMap.get(event.channel_id);
                  return (
                    <tr key={event.request_id}>
                      <td className="usage-mono">{event.request_id}</td>
                      <td>
                        <strong>{channel?.label ?? event.channel_id}</strong>
                        <span className="usage-table-subtext">{channel?.model_id ?? 'Unknown model'}</span>
                      </td>
                      <td>{number(event.input_tokens ?? 0)}</td>
                      <td>{number(event.cached_tokens ?? 0)}</td>
                      <td>{number(event.output_tokens ?? 0)}</td>
                      <td>{event.latency_ms === null ? '—' : `${number(event.latency_ms)} ms`}</td>
                      <td>
                        <span className={`usage-status ${statusClass(event.status)}`}>{event.status}</span>
                      </td>
                      <td>{event.credits_charged === null ? '—' : formatCredits(event.credits_charged)}</td>
                      <td className="usage-nowrap">{formatTimestamp(event.created_at)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="usage-card usage-details-card">
        <div className="usage-card-heading">
          <div>
            <p className="usage-card-eyebrow">Credit movement</p>
            <h2>Ledger</h2>
          </div>
          <span className="usage-card-count">{ledgerPage.length}</span>
        </div>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Credits</th>
                <th>Request</th>
                <th>Channel</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {ledgerPage.length === 0 ? (
                <tr>
                  <td colSpan={5} className="usage-table-empty">
                    No ledger entries yet.
                  </td>
                </tr>
              ) : (
                ledgerPage.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <span className={`usage-status ${statusClass(entry.kind)}`}>{entry.kind}</span>
                    </td>
                    <td className={entry.credits < 0 ? 'usage-negative' : 'usage-positive'}>
                      {entry.credits > 0 ? '+' : ''}
                      {formatCredits(entry.credits)}
                    </td>
                    <td className="usage-mono">{entry.request_id}</td>
                      <td>{entry.channel_id === null ? '—' : channelName(entry.channel_id, channelMap)}</td>
                    <td className="usage-nowrap">{formatTimestamp(entry.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="usage-pagination">
          {cursor !== undefined && (
            <Link href={ledgerNewestHref} className="usage-muted-button">
              ← Newest
            </Link>
          )}
          {nextCursor !== null && ledgerOlderHref !== null && (
            <Link href={ledgerOlderHref} className="usage-muted-button">
              Older →
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}

export default function UsageDashboard({
  events,
  ledgerPage,
  channels,
  from,
  to,
  status,
  cursor,
  nextCursor,
  ledgerNewestHref,
  ledgerOlderHref,
  renderedAt,
  initialTab,
}: UsageDashboardProps) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [period, setPeriod] = useState<Period>('today');
  const channelMap = useMemo(() => new Map(channels.map((channel) => [channel.id, channel])), [channels]);
  const visibleEvents = useMemo(() => {
    const start = periodStart(period, renderedAt);
    return events.filter((event) => {
      const timestamp = new Date(event.created_at).getTime();
      return Number.isFinite(timestamp) && timestamp >= start && timestamp <= renderedAt;
    });
  }, [events, period, renderedAt]);

  const summary = useMemo(() => {
    const inputTokens = visibleEvents.reduce((total, event) => total + (event.input_tokens ?? 0), 0);
    const cachedTokens = visibleEvents.reduce((total, event) => total + (event.cached_tokens ?? 0), 0);
    const outputTokens = visibleEvents.reduce((total, event) => total + (event.output_tokens ?? 0), 0);
    const providerCost = visibleEvents.reduce(
      (total, event) => total + eventCost(event),
      0,
    );
    return {
      requests: visibleEvents.length,
      inputTokens,
      cachedTokens,
      outputTokens,
      providerCost,
    };
  }, [visibleEvents]);

  return (
    <section className="usage-shell">
      <div className="usage-shell-inner">
        <header className="usage-page-header">
          <div className="usage-title-group">
            <div className="usage-title-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div>
              <h1>Usage &amp; Analytics</h1>
              <p>Monitor API usage, token consumption, and request logs.</p>
            </div>
          </div>
          <div className="usage-header-actions">
            <span className="usage-header-status">
              <span className="usage-live-dot" aria-hidden="true" />
              Recorded data
            </span>
            <Link href="/docs" className="usage-docs-link">
              API docs
            </Link>
          </div>
        </header>

        <OverviewHeader
          activeTab={activeTab}
          period={period}
          onTabChange={setActiveTab}
          onPeriodChange={setPeriod}
        />

        {activeTab === 'overview' ? (
          <>
            <div className="usage-kpi-grid">
              <KpiCard label="Total requests" value={number(summary.requests)} accent="orange" />
              <KpiCard
                label="Total input tokens"
                value={number(summary.inputTokens + summary.cachedTokens)}
                hint="Includes cached input"
                accent="coral"
              />
              <KpiCard label="Cached tokens" value={number(summary.cachedTokens)} accent="blue" />
              <KpiCard label="Output tokens" value={number(summary.outputTokens)} accent="green" />
              <KpiCard
                label="Provider cost"
                value={currency(summary.providerCost)}
                hint="Recorded from request pricing"
                accent="yellow"
              />
            </div>

            <div className="usage-overview-grid">
              <section className="usage-card usage-topology-card">
                <div className="usage-card-heading">
                  <div>
                    <p className="usage-card-eyebrow">Routing topology</p>
                    <h2>Generation channels</h2>
                  </div>
                  <span className="usage-card-count">
                    {new Set(visibleEvents.map((event) => event.channel_id)).size} observed
                  </span>
                </div>
                <ProviderTopology channels={channels} events={visibleEvents} channelMap={channelMap} />
              </section>
              <RecentRequests events={visibleEvents} channelMap={channelMap} renderedAt={renderedAt} />
            </div>

            <TrendChart events={visibleEvents} period={period} renderedAt={renderedAt} />
          </>
        ) : (
          <DetailsView
            events={events}
            ledgerPage={ledgerPage}
            channelMap={channelMap}
            from={from}
            to={to}
            status={status}
            cursor={cursor}
            nextCursor={nextCursor}
            ledgerNewestHref={ledgerNewestHref}
            ledgerOlderHref={ledgerOlderHref}
            onOverview={() => setActiveTab('overview')}
          />
        )}
      </div>
    </section>
  );
}
