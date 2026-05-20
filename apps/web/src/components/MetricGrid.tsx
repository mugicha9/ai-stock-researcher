import { formatNumber, formatPercent, formatYen } from "../lib/format";

type MetricGridProps = {
  metrics?: Record<string, number | string | null> | null;
  marketCap?: number | string | null;
};

const metricLabels: { key: string; label: string; formatter?: (value: number | string | null | undefined) => string }[] = [
  { key: "per", label: "PER", formatter: formatNumber },
  { key: "pbr", label: "PBR", formatter: formatNumber },
  { key: "psr", label: "PSR", formatter: formatNumber },
  { key: "roe", label: "ROE", formatter: formatPercent },
  { key: "roic", label: "ROIC", formatter: formatPercent },
  { key: "operating_margin", label: "営業利益率", formatter: formatPercent },
  { key: "revenue_growth", label: "売上成長率", formatter: formatPercent },
  { key: "operating_profit_growth", label: "営業利益成長", formatter: formatPercent },
  { key: "equity_ratio", label: "自己資本比率", formatter: formatPercent }
];

export function MetricGrid({ metrics, marketCap }: MetricGridProps) {
  return (
    <div className="metric-grid">
      <div className="metric-cell">
        <span>時価総額</span>
        <strong>{formatYen(marketCap)}</strong>
      </div>
      {metricLabels.map((item) => (
        <div className="metric-cell" key={item.key}>
          <span>{item.label}</span>
          <strong>{item.formatter ? item.formatter(metrics?.[item.key]) : formatNumber(metrics?.[item.key])}</strong>
        </div>
      ))}
    </div>
  );
}

