export function MetricTile({
  label,
  value,
  foot,
}: {
  label: string;
  value: string | number;
  foot: string;
}) {
  return (
    <article className="card metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-foot">{foot}</div>
    </article>
  );
}
