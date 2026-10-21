"use client";

import { Suspense, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import FormContainer from "../../components/FormContainer";
import DrawnCheck from "../../components/DrawnCheck";
import { ErrorText, Field, PrimaryButton } from "../../components/ui";
import { API_URL, apiError } from "../../lib/api";
import { useT } from "../../components/I18nProvider";

function ResetPasswordForm() {
  const t = useT();
  // The token travels in the link's query string; it is sent to the API in a POST body, never logged by us.
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError(t("reset.mismatch"));
      return;
    }
    setSubmitting(true);
    try {
      await axios.post(`${API_URL}/auth/reset-password`, { token, password });
      setDone(true);
    } catch (err) {
      setError(apiError(err, t("common.tryAgain")));
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <FormContainer title={t("forgot.title")}>
        <div className="space-y-5 text-center">
          <p>{t("reset.incomplete")}</p>
          <Link href="/forgot-password" className="btn btn-secondary">
            {t("reset.requestNew")}
          </Link>
        </div>
      </FormContainer>
    );
  }

  if (done) {
    return (
      <FormContainer title={t("reset.doneTitle")}>
        <div className="space-y-5 text-center">
          <DrawnCheck />
          <p>{t("reset.done")}</p>
          <Link
            href="/login"
            className="btn btn-primary"
          >
            {t("common.logIn")}
          </Link>
        </div>
      </FormContainer>
    );
  }

  return (
    <FormContainer title={t("reset.chooseTitle")}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <Field
          id="password"
          label={t("reset.newPassword")}
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          minLength={8}
          maxLength={72}
          hint={t("common.passwordHint")}
        />
        <Field
          id="confirm"
          label={t("reset.repeat")}
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          minLength={8}
          maxLength={72}
        />
        <ErrorText>{error}</ErrorText>
        <PrimaryButton className="btn-glint-once w-full text-lg" type="submit" disabled={submitting}>
          {submitting ? t("reset.saving") : t("reset.save")}
        </PrimaryButton>
      </form>
    </FormContainer>
  );
}

export default function ResetPasswordPage() {
  // useSearchParams needs a Suspense boundary so the page can still be pre-rendered.
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
