"use client";

import { useState, useEffect } from "react";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";
import FormContainer from "../../components/FormContainer";
import Link from "next/link";
import GoogleSignIn from "../../components/GoogleSignIn";
import { API_URL, apiError } from "../../lib/api";
import { useT } from "../../components/I18nProvider";
import { cleanCode } from "../../lib/twoFactor";
import type { User } from "../../types";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  // Set when the password was right and a code from the authenticator app is still needed.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const router = useRouter();
  const { login } = useAuth();
  const t = useT();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    try {
      const response = await axios.post(`${API_URL}/login`, { email, password });
      finishFirstStep(response.data);
    } catch (err) {
      setError(apiError(err, t("login.failed")));
    }
  };

  // After the password (or Google): signed in, or one more step.
  const finishFirstStep = (data: { user?: User; twoFactorRequired?: boolean; challenge?: string }) => {
    if (data.twoFactorRequired && data.challenge) {
      setChallenge(data.challenge);
      setCode("");
      setUseRecovery(false);
      return;
    }
    login(data.user as User);
    router.push("/dashboard");
  };

  const handleSecondStep = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const body = useRecovery ? { challenge, recoveryCode: code.trim() } : { challenge, code: cleanCode(code) };
      const response = await axios.post(`${API_URL}/auth/two-factor`, body);
      login(response.data.user);
      router.push("/dashboard");
    } catch (err) {
      const reason = axios.isAxiosError(err) ? err.response?.data?.code : "";
      if (reason === "challenge_expired") {
        // too slow, or too many wrong codes: the password has to be given again
        setChallenge(null);
        setPassword("");
        setError(t("login.codeExpired"));
      } else {
        setError(reason === "invalid_code" ? t("login.codeFailed") : apiError(err, t("login.codeFailed")));
      }
    }
  };
  if (challenge) {
    return (
      <FormContainer title={t("login.codeTitle")}>
        <form onSubmit={handleSecondStep} className="flex flex-col gap-5" data-testid="second-step">
          <p>{useRecovery ? t("login.recoveryIntro") : t("login.codeIntro")}</p>
          <div className="w-full">
            <label className="label" htmlFor="second-step-code">
              {useRecovery ? t("login.recoveryLabel") : t("login.codeLabel")}
            </label>
            <input
              className="field"
              id="second-step-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              autoFocus
              required
              maxLength={16}
            />
          </div>
          {error && (
            <p className="text-base font-medium text-danger" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary w-full text-lg">
            {t("login.codeSubmit")}
          </button>
          <button
            type="button"
            className="text-sm text-accent underline underline-offset-2"
            onClick={() => {
              setUseRecovery(!useRecovery);
              setCode("");
              setError("");
            }}
          >
            {useRecovery ? t("login.useApp") : t("login.useRecovery")}
          </button>
          <button
            type="button"
            className="text-sm text-accent underline underline-offset-2"
            onClick={() => {
              setChallenge(null);
              setPassword("");
              setError("");
            }}
          >
            {t("login.startAgain")}
          </button>
        </form>
      </FormContainer>
    );
  }

  return (
    <FormContainer title={t("login.title")}>
      {/* Email / password form */}
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-5"
      >
        <div className="w-full">
          <label
            className="label"
            htmlFor="email"
          >
            {t("common.email")}
          </label>
          <input
            className="field"
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="w-full">
          <label
            className="label"
            htmlFor="password"
          >
            {t("common.password")}
          </label>
          <input
            className="field"
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <p className="mt-2 text-sm">
            <Link href="/forgot-password" className="tap-target text-accent underline underline-offset-2">
              {t("login.forgot")}
            </Link>
          </p>
        </div>

        {error && (
          <p className="text-base font-medium text-danger" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-primary w-full text-lg"
        >
          {t("login.submit")}
        </button>
      </form>

      <GoogleSignIn label={t("login.google")} onDone={finishFirstStep} onError={setError} />
    </FormContainer>
  );
}
