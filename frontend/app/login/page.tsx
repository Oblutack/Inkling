"use client";

import { useState, useRef, useEffect } from "react";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";
import FormContainer from "../../components/FormContainer";
import Link from "next/link";
import { GoogleLogin, CredentialResponse } from "@react-oauth/google";
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

  const googleLoginButtonRef = useRef<HTMLDivElement>(null);

  const handleCustomGoogleClick = () => {
    const googleButton =
      googleLoginButtonRef.current?.querySelector('div[role="button"]');
    if (googleButton instanceof HTMLElement) {
      googleButton.click();
    }
  };

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
  const handleGoogleLoginSuccess = async (
    credentialResponse: CredentialResponse
  ) => {
    const idToken = credentialResponse.credential;
    if (!idToken) {
      setError(t("login.googleFailedShort"));
      return;
    }

    try {
      // Exchange the Google credential for our own token
      const response = await axios.post(`${API_URL}/auth/google`, { token: idToken });

      // The rest is the same as a regular login
      finishFirstStep(response.data);
    } catch (err) {
      setError(apiError(err, t("login.googleFailed")));
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
            <Link href="/forgot-password" className="text-accent underline underline-offset-2">
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

      {/* Separator */}
      <div className="my-5 flex items-center gap-3 text-sm text-ink/70 before:h-px before:flex-1 before:bg-ink/20 after:h-px after:flex-1 after:bg-ink/20">
        {t("login.or")}
      </div>

      {/* Google sign-in */}
      <div className="flex justify-center">
        {/* Our styled button */}
        <button
          type="button"
          onClick={handleCustomGoogleClick}
          className="btn btn-secondary w-full gap-3"
        >
          {/* Google SVG Logo */}
          <svg className="w-6 h-6" viewBox="0 0 48 48">
            <path
              fill="#FFC107"
              d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C12.955 4 4 12.955 4 24s8.955 20 20 20s20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
            ></path>
            <path
              fill="#FF3D00"
              d="M6.306 14.691c-1.319 3.197-2.164 6.745-2.164 10.559C4.142 35.845 13.488 44 24 44c5.166 0 9.86-1.556 13.694-4.205l-5.657-5.657C30.046 36.686 27.218 38 24 38c-4.969 0-9.102-3.214-10.61-7.533z"
            ></path>
            <path
              fill="#4CAF50"
              d="M24 44c5.166 0 9.86-1.556 13.694-4.205l-5.657-5.657C30.046 36.686 27.218 38 24 38c-4.969 0-9.102-3.214-10.61-7.533L7.34 34.694C10.596 41.282 16.83 44 24 44z"
            ></path>
            <path
              fill="#1976D2"
              d="M43.611 20.083H42V20H24v8h11.303c-0.792 2.237-2.231 4.16-4.087 5.571l5.657 5.657C41.813 36.467 44 32.062 44 27.521c0-2.641-0.649-5.114-1.789-7.225z"
            ></path>
          </svg>
          <span>{t("login.google")}</span>
        </button>
      </div>

      {/* The real Google button, invisible and layered on top so clicks reach it */}
      <div
        ref={googleLoginButtonRef}
        className="opacity-0 absolute top-0 left-0 -z-10"
      >
        <GoogleLogin
          onSuccess={handleGoogleLoginSuccess}
          onError={() => {
            setError(t("login.googleError"));
          }}
        />
      </div>
    </FormContainer>
  );
}
