"use client";
import { useRef } from "react";
import axios from "axios";
import { GoogleLogin, type CredentialResponse } from "@react-oauth/google";
import { API_URL, apiError } from "../lib/api";
import type { User } from "../types";
import { useT } from "./I18nProvider";

// What the server answers once Google has vouched for the address: the person is signed in, or a code is still needed.
export interface FirstStep {
  user?: User;
  twoFactorRequired?: boolean;
  challenge?: string;
}

// "Or", and a button that signs in with Google. The same server step serves the login and the sign-up page: an address
// that has no account yet gets one, and one that has an account is signed in.
export default function GoogleSignIn({
  label,
  onDone,
  onError,
}: {
  label: string;
  onDone: (data: FirstStep) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const realButton = useRef<HTMLDivElement>(null);

  const clickRealButton = () => {
    const button = realButton.current?.querySelector('div[role="button"]');
    if (button instanceof HTMLElement) button.click();
  };

  const handleSuccess = async (credentialResponse: CredentialResponse) => {
    const idToken = credentialResponse.credential;
    if (!idToken) {
      onError(t("login.googleFailedShort"));
      return;
    }
    try {
      // The Google credential is exchanged for our own session.
      const response = await axios.post(`${API_URL}/auth/google`, { token: idToken });
      onDone(response.data);
    } catch (err) {
      onError(apiError(err, t("login.googleFailed")));
    }
  };

  return (
    <>
      <div className="my-5 flex items-center gap-3 text-sm text-ink/70 before:h-px before:flex-1 before:bg-ink/20 after:h-px after:flex-1 after:bg-ink/20">
        {t("login.or")}
      </div>

      <div className="flex justify-center">
        {/* Our own button, in the look of the page */}
        <button type="button" onClick={clickRealButton} className="btn btn-secondary w-full gap-3">
          <svg className="h-6 w-6" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C12.955 4 4 12.955 4 24s8.955 20 20 20s20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
            <path fill="#FF3D00" d="M6.306 14.691c-1.319 3.197-2.164 6.745-2.164 10.559C4.142 35.845 13.488 44 24 44c5.166 0 9.86-1.556 13.694-4.205l-5.657-5.657C30.046 36.686 27.218 38 24 38c-4.969 0-9.102-3.214-10.61-7.533z" />
            <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.556 13.694-4.205l-5.657-5.657C30.046 36.686 27.218 38 24 38c-4.969 0-9.102-3.214-10.61-7.533L7.34 34.694C10.596 41.282 16.83 44 24 44z" />
            <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-0.792 2.237-2.231 4.16-4.087 5.571l5.657 5.657C41.813 36.467 44 32.062 44 27.521c0-2.641-0.649-5.114-1.789-7.225z" />
          </svg>
          <span>{label}</span>
        </button>
      </div>

      {/* The real Google button, invisible and layered underneath so that a click on ours reaches it */}
      <div ref={realButton} className="absolute left-0 top-0 -z-10 opacity-0">
        <GoogleLogin onSuccess={handleSuccess} onError={() => onError(t("login.googleError"))} />
      </div>
    </>
  );
}
