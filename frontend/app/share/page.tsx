"use client";

import { Suspense, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useT } from "../../components/I18nProvider";
import { useAuth } from "../../contexts/AuthContext";
import { API_URL } from "../../lib/api";
import { interpretShare } from "../../lib/share";
import { clearShare, readShare, type SharedPayload } from "../../lib/shareStore";

const EInkForm = dynamic(() => import("../../components/EInkForm"), { ssr: false });

type Phase = "loading" | "none" | "item";

// Where something shared to Inkling from another app lands: the same box as the dashboard, already filled in, ready to be
// summarized or made into flashcards.
function Share() {
  const t = useT();
  const { user } = useAuth();
  const router = useRouter();
  const missing = useSearchParams().get("missing") === "1";
  const [phase, setPhase] = useState<Phase>("loading");
  const [shared, setShared] = useState<SharedPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    readShare().then((payload) => {
      if (cancelled) return;
      if (payload && interpretShare(payload, payload.files.length).kind !== "empty") {
        setShared(payload);
        setPhase("item");
      } else {
        setPhase("none");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const content = shared ? interpretShare(shared, shared.files.length) : null;
  const initialText = content?.kind === "link" ? content.link : content?.kind === "text" ? content.text : undefined;
  const initialFiles = content?.kind === "files" ? shared?.files : undefined;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:py-10">
      <h1 className="mb-4 text-3xl md:text-4xl">{t("share.title")}</h1>

      {phase === "loading" && <p role="status">{t("common.loading")}</p>}

      {phase === "none" && (
        <div className="card text-center" data-testid="share-none">
          <p role={missing ? "alert" : undefined}>{missing ? t("share.missing") : t("share.nothing")}</p>
          <Link href="/dashboard" className="btn btn-secondary mt-5">
            {t("share.library")}
          </Link>
        </div>
      )}

      {phase === "item" && (
        <div className="card md:p-8" data-testid="share-item">
          <p className="mb-5 text-ink/80">{t("share.intro")}</p>
          <EInkForm
            // Signed in, a summary is kept in the library; without an account it is only shown, as on the front page.
            endpoint={user ? `${API_URL}/summarize` : `${API_URL}/public/summarize`}
            initialText={initialText}
            initialFiles={initialFiles}
            onSummaryCreated={() => void clearShare()}
            onStudySetCreated={(id) => {
              void clearShare();
              try {
                // The library opens the new set on its flashcards (see the dashboard).
                sessionStorage.setItem("inkling.openStudy", String(id));
              } catch {
                // without it the set is simply listed
              }
              router.push("/dashboard");
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function SharePage() {
  return (
    <Suspense fallback={null}>
      <Share />
    </Suspense>
  );
}
