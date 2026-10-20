"use client";
import { useState } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { API_URL, apiError } from "../lib/api";
import { useT } from "./I18nProvider";

// Shown to signed-in users whose email address isn't confirmed yet.
export default function VerifyBanner() {
  const { user } = useAuth();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const t = useT();

  if (!user || user.emailVerified) return null;

  const resend = async () => {
    setSending(true);
    try {
      const response = await axios.post(`${API_URL}/auth/resend-verification`);
      setMessage(response.data.message);
    } catch (err) {
      setMessage(apiError(err, t("verify.sendFailed")));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-accent px-4 py-2.5 text-center text-sm font-medium text-accent-fg" role="status">
      {message || t("verify.banner")}{" "}
      {!message && (
        <button onClick={resend} disabled={sending} className="tap-target font-semibold underline underline-offset-2 hover:opacity-80 disabled:opacity-50">
          {sending ? t("verify.sending") : t("verify.resend")}
        </button>
      )}
    </div>
  );
}
