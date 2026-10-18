"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import FormContainer from "../../components/FormContainer";
import { useT } from "../../components/I18nProvider";
import { API_URL } from "../../lib/api";

type Status = "working" | "done" | "failed";

// The page the link at the bottom of an email opens. It needs no login: the token in the link is the proof. A POST, so that
// a mail scanner that opens every link in an email does not switch emails off by itself.
function Unsubscribe() {
  const t = useT();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const kind = params.get("kind") ?? "all";
  const [status, setStatus] = useState<Status>("working");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setStatus("failed");
      return;
    }
    axios
      .post(`${API_URL}/email/unsubscribe`, { token, kind })
      .then(() => setStatus("done"))
      .catch(() => setStatus("failed"));
  }, [token, kind]);

  return (
    <FormContainer title={t("unsubscribe.title")}>
      <div className="space-y-5 text-center">
        {status === "working" && <p>{t("unsubscribe.working")}</p>}
        {status === "done" && <p role="status">{t("unsubscribe.done")}</p>}
        {status === "failed" && <p role="alert">{t("unsubscribe.failed")}</p>}
        <Link href="/account" className="btn btn-primary">
          {t("unsubscribe.settings")}
        </Link>
      </div>
    </FormContainer>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={null}>
      <Unsubscribe />
    </Suspense>
  );
}
