"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";
import { useT } from "../../components/I18nProvider";
import WatchCard from "../../components/WatchCard";
import { API_URL, apiError } from "../../lib/api";
import type { Watch, WatchList } from "../../lib/watch";

// The pages a person watches: what each last found, and the way to check, pause or remove them.
function Watches() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const t = useT();
  const params = useSearchParams();
  const added = params.get("added") === "1";
  const openId = Number(params.get("open")) || 0;
  const [list, setList] = useState<WatchList | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await axios.get<WatchList>(`${API_URL}/watches`);
      setList(response.data);
      setError("");
    } catch (err) {
      setError(apiError(err, t("watch.loadFailed")));
    }
  }, [t]);

  useEffect(() => {
    if (!authLoading && !user) router.push("/login");
  }, [authLoading, user, router]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (authLoading || !user) return <p className="mt-20 text-center text-lg text-ink/70">{t("common.loadingDashboard")}</p>;

  const replace = (watch: Watch) => setList((prev) => (prev ? { ...prev, watches: prev.watches.map((w) => (w.id === watch.id ? watch : w)) } : prev));
  const remove = (id: number) => setList((prev) => (prev ? { ...prev, watches: prev.watches.filter((w) => w.id !== id) } : prev));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:py-10">
      <h1 className="mb-2 text-3xl md:text-4xl">{t("watch.title")}</h1>
      <p className="muted mb-6">{t("watch.intro")}</p>

      {added && (
        <p className="mb-5 rounded-xl border border-accent/40 bg-accent/10 p-3 font-medium" role="status" data-testid="watch-added">
          {t("watch.addedBanner")}
        </p>
      )}
      {error && (
        <p className="mb-4 text-base font-medium text-danger" role="alert">
          {error}
        </p>
      )}
      {!list && !error && <p role="status">{t("common.loading")}</p>}

      {list && list.watches.length === 0 && (
        <div className="card text-center" data-testid="watch-empty">
          <p>{t("watch.empty")}</p>
          <Link href="/dashboard" className="btn btn-secondary mt-5">
            {t("nav.dashboard")}
          </Link>
        </div>
      )}

      {list && list.watches.length > 0 && (
        <>
          <p className="muted mb-4 text-sm" data-testid="watch-limit">
            {t("watch.limit", { n: list.watches.length, max: list.limit })}
          </p>
          <ul className="space-y-6">
            {list.watches.map((watch) => (
              <WatchCard
                key={watch.id}
                watch={watch}
                minHours={list.minHours}
                openAtStart={watch.id === openId}
                onList={setList}
                onWatch={replace}
                onRemoved={remove}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function WatchesPage() {
  return (
    <Suspense fallback={null}>
      <Watches />
    </Suspense>
  );
}
