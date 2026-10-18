"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useRouter } from "next/navigation";
import axios from "axios";
import type { Document } from "../../types";
import { API_URL } from "../../lib/api";
import dynamic from "next/dynamic";
import { AnimatePresence } from "framer-motion";
import { useT } from "../../components/I18nProvider";
import { DocumentListSkeleton } from "../../components/Skeleton";
import { fieldClass } from "../../components/styles";

function Loading({ what }: { what: "common.loadingForm" | "common.loadingDocument" }) {
  return <p>{useT()(what)}</p>;
}

const EInkForm = dynamic(() => import("../../components/EInkForm"), {
  ssr: false,
  loading: () => <Loading what="common.loadingForm" />,
});

// Declared at module scope: creating this inside the component would give React a new component
// type on every render, remounting every card (and discarding an open chat) each time.
const DocumentCard = dynamic(() => import("../../components/DocumentCard"), {
  ssr: false,
  loading: () => <Loading what="common.loadingDocument" />,
});

// Chat across every saved document.
const LibraryChat = dynamic(() => import("../../components/LibraryChat"), { ssr: false });

const PAGE_SIZE = 20;
const SEARCH_DELAY_MS = 300;

interface TagCount {
  tag: string;
  count: number;
}

export default function DashboardPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const t = useT();
  const [documents, setDocuments] = useState<Document[]>([]);
  // False until the first page of the current search has arrived: a skeleton is shown until then.
  const [loaded, setLoaded] = useState(false);
  // Cursor for the next (older) page; empty when everything is loaded.
  const [nextCursor, setNextCursor] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");

  // What is typed in the search box, and what is actually searched (a moment later, so each keystroke is not a request).
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<TagCount[]>([]);
  // The library chat is offered while anything with text is saved, even when a search hides it.
  const [libraryAvailable, setLibraryAvailable] = useState(false);
  // The study set that was just made: its card opens on the flashcards.
  const [newStudySet, setNewStudySet] = useState<number | null>(null);
  // Only the newest search may fill the list.
  const latest = useRef(0);

  const requestPage = useCallback(
    async (before?: string) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before) params.set("before", before);
      if (query) params.set("q", query);
      if (tag) params.set("tag", tag);
      const response = await axios.get<Document[]>(`${API_URL}/documents?${params.toString()}`);
      return { docs: response.data, next: (response.headers["x-next-cursor"] as string) || "" };
    },
    [query, tag]
  );

  const fetchTags = useCallback(async () => {
    try {
      const response = await axios.get<TagCount[]>(`${API_URL}/documents/tags`);
      setTags(response.data);
    } catch {
      // Tags only narrow the list; without them everything still works.
    }
  }, []);

  // Loads (or refreshes) the newest page. Older pages the user already loaded are kept.
  const fetchDocuments = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const page = await requestPage();
      if (mine !== latest.current) return;
      setLoadError("");
      setDocuments((prev) => {
        const oldest = page.docs.length > 0 ? page.docs[page.docs.length - 1].ID : 0;
        const older = prev.filter((d) => d.ID < oldest);
        if (older.length === 0) setNextCursor(page.next);
        return [...page.docs, ...older];
      });
    } catch (error) {
      if (mine !== latest.current) return;
      console.error("Failed to fetch documents", error);
      setLoadError(t("dashboard.loadError"));
    } finally {
      if (mine === latest.current) setLoaded(true);
    }
    void fetchTags();
  }, [requestPage, fetchTags, t]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await requestPage(nextCursor);
      setLoadError("");
      setDocuments((prev) => [...prev, ...page.docs.filter((d) => !prev.some((p) => p.ID === d.ID))]);
      setNextCursor(page.next);
    } catch (error) {
      console.error("Failed to load more documents", error);
      setLoadError(t("dashboard.loadMoreError"));
    } finally {
      setLoadingMore(false);
    }
  };

  const handleDeleteDocument = async (id: number) => {
    // Ask the user to confirm
    if (!window.confirm(t("dashboard.confirmDelete"))) {
      return;
    }

    try {
      await axios.delete(`${API_URL}/documents/${id}`);

      // Remove the document locally so the UI responds immediately
      setDocuments((prev) => prev.filter((doc) => doc.ID !== id));
      void fetchTags();
    } catch (error) {
      console.error("Failed to delete document", error);
      setLoadError(t("dashboard.deleteError"));
    }
  };

  // A card changed (renamed, tagged, rewritten, shared): keep the list in step without reloading it.
  const handleChange = useCallback(
    (id: number, patch: Partial<Document>) => {
      setDocuments((prev) => prev.map((d) => (d.ID === id ? { ...d, ...patch } : d)));
      if (patch.tags) void fetchTags();
    },
    [fetchTags]
  );

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  // The search box feeds the actual search after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // A new search (or tag) starts a new list; the same filters again refresh the newest page.
  useEffect(() => {
    if (!user) return;
    setLoaded(false);
    setDocuments([]);
    setNextCursor("");
    void fetchDocuments();
  }, [user, query, tag]); // eslint-disable-line react-hooks/exhaustive-deps

  // Without a search or tag, the list is everything: it says whether the library chat has anything to read.
  useEffect(() => {
    if (loaded && !query && !tag) setLibraryAvailable(documents.some((d) => d.hasContent));
  }, [documents, loaded, query, tag]);

  if (loading) {
    return <p className="mt-20 text-center text-lg text-ink/70">{t("common.loadingDashboard")}</p>;
  }

  const filtering = Boolean(query || tag);
  // The tag filter is only worth showing once there are tags (or one is chosen).
  const showFilters = libraryAvailable || documents.length > 0 || filtering || tags.length > 0;

  return user ? (
    <div className="mx-auto max-w-4xl px-4 py-8 md:py-10">
      <h1 className="mb-6 text-3xl md:text-4xl">
        {t("dashboard.title")}
      </h1>

      {/* New summary form */}
      <div className="card mb-8 md:p-8">
        <EInkForm
          endpoint={`${API_URL}/summarize`}
          onSummaryCreated={fetchDocuments}
          onStudySetCreated={(id) => {
            setNewStudySet(id);
            void fetchDocuments();
          }}
        />
      </div>

      {/* One question across everything saved */}
      {libraryAvailable && <LibraryChat tags={tags} activeTag={tag} />}

      {/* Saved summaries */}
      <div>
        <h2 className="mb-4 text-2xl md:text-3xl">
          {t("dashboard.saved")}
        </h2>

        {showFilters && (
          <div className="mb-5" data-testid="filters">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={100}
              placeholder={t("dashboard.search")}
              aria-label={t("dashboard.search")}
              className={`${fieldClass} w-full`}
            />
            {(tags.length > 0 || tag) && (
              <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label={t("dashboard.filterByTag")}>
                <button
                  type="button"
                  onClick={() => setTag("")}
                  aria-pressed={!tag}
                  className="chip py-1"
                >
                  {t("dashboard.all")}
                </button>
                {tags.map((t) => (
                  <button
                    key={t.tag}
                    type="button"
                    onClick={() => setTag(tag === t.tag ? "" : t.tag)}
                    aria-pressed={tag === t.tag}
                    className="chip py-1"
                  >
                    {t.tag} ({t.count})
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {loadError && (
          <p className="mb-4 text-base font-medium text-danger" role="alert">
            {loadError}
          </p>
        )}

        {!loaded ? (
          <DocumentListSkeleton />
        ) : (
          <div className="space-y-6">
            <AnimatePresence>
              {documents.length > 0 ? (
                documents.map((doc) => (
                  <DocumentCard
                    key={doc.ID}
                    doc={doc}
                    onDelete={handleDeleteDocument}
                    onChange={handleChange}
                    openStudy={doc.ID === newStudySet}
                  />
                ))
              ) : (
                <p className="rounded-2xl border border-dashed border-ink/30 p-8 text-center text-ink/70">
                  {filtering ? t("dashboard.noMatch") : t("dashboard.empty")}
                </p>
              )}
            </AnimatePresence>
          </div>
        )}

        {nextCursor && (
          <div className="mt-8 flex justify-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="btn btn-secondary"
            >
              {loadingMore ? t("common.loading") : t("dashboard.loadMore")}
            </button>
          </div>
        )}
      </div>
    </div>
  ) : null;
}
