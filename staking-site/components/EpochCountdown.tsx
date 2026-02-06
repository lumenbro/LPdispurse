"use client";

import { useEffect, useState } from "react";

export function EpochCountdown() {
  const [minutesLeft, setMinutesLeft] = useState<number>(() => {
    const now = new Date();
    return 60 - now.getMinutes();
  });

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setMinutesLeft(60 - now.getMinutes());
    };
    const interval = setInterval(tick, 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="rounded-lg border border-yellow-800/30 bg-yellow-900/10 px-4 py-3 text-sm text-yellow-200">
      <span className="font-bold">{minutesLeft}</span> min until next epoch
      scan. Your LP will start earning rewards after detection.
    </div>
  );
}
