"use client";

import { useState } from "react";
import axios from "axios";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";
import GoogleSignIn, { type FirstStep } from "../../components/GoogleSignIn";
import FormContainer from "../../components/FormContainer";
import TurnstileWidget, { turnstileEnabled } from "../../components/Turnstile";
import { ErrorText, Field, PrimaryButton } from "../../components/ui";
import { API_URL, TURNSTILE_HEADER, apiError } from "../../lib/api";
import { useT } from "../../components/I18nProvider";
import DrawnCheck from "../../components/DrawnCheck";

export default function SignupPage() {
  const t = useT();
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [humanToken, setHumanToken] = useState("");
  const [humanReset, setHumanReset] = useState(0);

  // Google has vouched for the address, so there is no mail to confirm: a new account is made and signed in at once.
  const googleDone = (data: FirstStep) => {
    if (data.user) {
      login(data.user);
      router.push("/dashboard");
    } else {
      // An account that already exists and uses two-step sign-in has to go through the login page, where the code is asked for.
      setError(t("signup.googleUseLogin"));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      await axios.post(
        `${API_URL}/signup`,
        { email, password },
        { headers: humanToken ? { [TURNSTILE_HEADER]: humanToken } : {} }
      );
      setCreated(true);
    } catch (err) {
      setError(apiError(err, t("signup.failed")));
      // The human-check token is single use, so ask for a new one before the next attempt.
      setHumanToken("");
      setHumanReset((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    return (
      <FormContainer title={t("signup.checkTitle")}>
        <div className="space-y-5 text-center">
          <DrawnCheck />
          <p>
            {t("signup.sentBefore")}
            <strong>{email}</strong>
            {t("signup.sentAfter")}
          </p>
          <p className="muted text-sm">{t("signup.later")}</p>
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
    <FormContainer title={t("signup.title")}>
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-5"
      >
        <Field
          id="email"
          label={t("common.email")}
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        <Field
          id="password"
          label={t("common.password")}
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          minLength={8}
          maxLength={72}
          hint={t("common.passwordHint")}
        />

        <TurnstileWidget onToken={setHumanToken} resetKey={humanReset} />
        <ErrorText>{error}</ErrorText>

        <PrimaryButton className="btn-glint-once w-full text-lg" type="submit" disabled={submitting || (turnstileEnabled && !humanToken)}>
          {submitting ? t("signup.creating") : t("signup.title")}
        </PrimaryButton>
      </form>

      <GoogleSignIn label={t("signup.google")} onDone={googleDone} onError={setError} />
    </FormContainer>
  );
}
