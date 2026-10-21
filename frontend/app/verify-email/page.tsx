"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import FormContainer from "../../components/FormContainer";
import DrawnCheck from "../../components/DrawnCheck";
import { useAuth } from "../../contexts/AuthContext";
import { API_URL, apiError } from "../../lib/api";
import { useT } from "../../components/I18nProvider";

type Status = "checking" | "ok" | "failed";

function VerifyEmail() {
  const t = useT();
  const token = useSearchParams().get("token") ?? "";
  const { refresh } = useAuth();
  const [status, setStatus] = useState<Status>("checking");
  const [message, setMessage] = useState("");
  // React strict mode runs effects twice in development; the link is single-use, so send it once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!token) {
      setStatus("failed");
      setMessage(t("confirm.incomplete"));
      return;
    }
    // A POST, not a GET: mail scanners that open every link in an email must not use the token up.
    axios
      .post(`${API_URL}/auth/verify-email`, { token })
      .then(async (response) => {
        setMessage(response.data.message);
        setStatus("ok");
        await refresh(); // update the "please confirm your email" banner if they're signed in
      })
      .catch((err) => {
        setMessage(apiError(err, t("confirm.invalid")));
        setStatus("failed");
      });
  }, [token, refresh, t]);

  return (
    <FormContainer title={status === "ok" ? t("confirm.doneTitle") : t("confirm.title")}>
      <div className="space-y-5 text-center">
        {status === "ok" && <DrawnCheck />}
        {status === "checking" && <p>{t("confirm.checking")}</p>}
        {status !== "checking" && <p role={status === "failed" ? "alert" : "status"}>{message}</p>}
        {status === "failed" && (
          <p className="muted text-sm">
            {t("confirm.hint")}
          </p>
        )}
        <Link
          href={status === "ok" ? "/dashboard" : "/login"}
          className="btn btn-primary"
        >
          {status === "ok" ? t("confirm.continue") : t("common.logIn")}
        </Link>
      </div>
    </FormContainer>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmail />
    </Suspense>
  );
}
