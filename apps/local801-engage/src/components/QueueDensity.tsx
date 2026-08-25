"use client";

import { useState, type ReactNode } from "react";

type Density = "compact" | "comfortable";

export function QueueDensity({ children, label }: { children: ReactNode; label: string }) {
  const [density, setDensity] = useState<Density>("compact");

  return <div className={`queue-density queue-density-${density}`}>
    <div className="queue-density-toggle" role="group" aria-label={`${label} density`}>
      <span>Density</span>
      <button className="button secondary" type="button" aria-pressed={density === "compact"} onClick={() => setDensity("compact")}>Compact</button>
      <button className="button secondary" type="button" aria-pressed={density === "comfortable"} onClick={() => setDensity("comfortable")}>Comfortable</button>
    </div>
    {children}
  </div>;
}
