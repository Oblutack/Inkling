"use client";
import { useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import type { StudyStats } from "../types";
import { API_URL } from "../lib/api";
import { syncTimeZone } from "../lib/timezone";
import { useT } from "./I18nProvider";

// On the dashboard: how many flashcards are due today, the streak, and the way into a review. Shown only when there is
// something to say (cards have been rated before), and quiet when the stats cannot be loaded.
export default function ReviewChip() {
  const t = useT();
  const [stats, setStats] = useState<StudyStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await syncTimeZone(); // so that "today" is the person's own
      try {
        const response = await axios.get<StudyStats>(`${API_URL}/study/stats`);
        if (!cancelled) setStats(response.data);
      } catch {
        // Nothing to show without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!stats || (stats.dueToday === 0 && stats.streak === 0)) return null;

  return (
    <div className="card mb-8 flex flex-wrap items-center justify-between gap-4" data-testid="review-chip">
      <div>
        <p className="text-lg font-semibold">{stats.dueToday > 0 ? t("dashboard.reviewDue", { n: stats.dueToday }) : t("dashboard.caughtUp")}</p>
        {stats.streak > 0 && <p className="muted text-sm">{t("dashboard.streak", { n: stats.streak })}</p>}
      </div>
      {stats.dueToday > 0 && (
        <Link href="/review" className="btn btn-primary">
          {t("dashboard.reviewStart")}
        </Link>
      )}
    </div>
  );
}
