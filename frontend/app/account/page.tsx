"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";
import { DangerButton, ErrorText, Field, SecondaryButton, SuccessText } from "../../components/ui";
import { API_URL, apiError } from "../../lib/api";
import type { SessionInfo, Usage } from "../../types";
import ApiKeys from "../../components/ApiKeys";
import EmailPreferences from "../../components/EmailPreferences";
import TwoFactor from "../../components/TwoFactor";
import { useT } from "../../components/I18nProvider";
import type { MessageKey, Params } from "../../lib/i18n";

type Translate = (key: MessageKey, params?: Params) => string;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2 className="mb-4 text-2xl">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

// A friendly device name from a User-Agent string; we only keep the broad family.
function deviceName(userAgent: string, t: Translate): string {
  const ua = userAgent.toLowerCase();
  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("chrome")
    ? "Chrome"
    : ua.includes("firefox")
    ? "Firefox"
    : ua.includes("safari")
    ? "Safari"
    : "Browser";
  const os = ua.includes("windows")
    ? "Windows"
    : ua.includes("iphone") || ua.includes("ipad")
    ? "iOS"
    : ua.includes("android")
    ? "Android"
    : ua.includes("mac os")
    ? "macOS"
    : ua.includes("linux")
    ? "Linux"
    : "";
  return os ? t("account.deviceOn", { browser, os }) : browser;
}

const MAX_INSTRUCTIONS = 500;

// Standing preferences that are added to every summary the account makes.
function InstructionsForm({ initial, onSaved }: { initial: string; onSaved: () => Promise<void> }) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    try {
      await axios.put(`${API_URL}/account/instructions`, { customInstructions: value });
      await onSaved();
      setMessage(value.trim() ? t("account.instructionsSaved") : t("account.instructionsCleared"));
    } catch (err) {
      setError(apiError(err, t("account.instructionsFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-3">
      <label className="label" htmlFor="instructions">
        {t("account.instructionsLabel")}
      </label>
      <textarea
        id="instructions"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={MAX_INSTRUCTIONS}
        rows={4}
        placeholder={t("account.instructionsPlaceholder")}
        className="field"
      />
      <p className="muted text-sm">
        {t("account.instructionsHelp", { count: value.length, max: MAX_INSTRUCTIONS })}
      </p>
      <ErrorText>{error}</ErrorText>
      <SuccessText>{message}</SuccessText>
      <SecondaryButton type="submit" disabled={saving}>
        {t("account.instructionsSave")}
      </SecondaryButton>
    </form>
  );
}

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const t = useT();
  const unlimited = limit === 0;
  const pct = unlimited ? 0 : Math.min(100, (used / limit) * 100);
  return (
    <div>
      <div className="flex justify-between">
        <span>{label}</span>
        <span>{unlimited ? t("account.usedToday", { used }) : `${used} / ${limit}`}</span>
      </div>
      <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-ink/15" aria-hidden="true">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function AccountPage() {
  const { user, loading, logout, refresh } = useAuth();
  const router = useRouter();
  const t = useT();

  const [usage, setUsage] = useState<Usage | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordError, setPasswordError] = useState("");

  const [confirmEmail, setConfirmEmail] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  // After deleting, go home instead of letting the "not signed in" redirect below send us to login.
  const [deleted, setDeleted] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([
        axios.get<Usage>(`${API_URL}/usage`),
        axios.get<SessionInfo[]>(`${API_URL}/auth/sessions`),
      ]);
      setUsage(u.data);
      setSessions(s.data);
    } catch (err) {
      setError(apiError(err, t("account.loadFailed")));
    }
  }, [t]);

  useEffect(() => {
    if (!loading && !user && !deleted) router.push("/login");
  }, [user, loading, deleted, router]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (loading || !user) {
    return <p className="mt-20 text-center text-lg text-ink/70">{t("common.loading")}</p>;
  }

  const resendVerification = async () => {
    setError("");
    setNotice("");
    try {
      const response = await axios.post(`${API_URL}/auth/resend-verification`);
      setNotice(response.data.message);
    } catch (err) {
      setError(apiError(err, t("verify.sendFailed")));
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError("");
    setPasswordMessage("");
    try {
      const response = await axios.post(`${API_URL}/auth/change-password`, { currentPassword, newPassword });
      setPasswordMessage(response.data.message);
      setCurrentPassword("");
      setNewPassword("");
      load();
    } catch (err) {
      setPasswordError(apiError(err, t("account.passwordFailed")));
    }
  };

  const revokeSession = async (id: number) => {
    setError("");
    try {
      await axios.delete(`${API_URL}/auth/sessions/${id}`);
      load();
    } catch (err) {
      setError(apiError(err, t("account.signOutDeviceFailed")));
    }
  };

  const signOutEverywhere = async () => {
    try {
      await axios.post(`${API_URL}/auth/logout-all`);
    } catch (err) {
      setError(apiError(err, t("account.signOutFailed")));
      return;
    }
    await logout();
    router.push("/login");
  };

  const exportData = async () => {
    setError("");
    try {
      const response = await axios.get(`${API_URL}/account/export`, { responseType: "blob" });
      const url = URL.createObjectURL(response.data);
      const link = document.createElement("a");
      link.href = url;
      link.download = "inkling-export.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(apiError(err, t("account.exportFailed")));
    }
  };

  const deleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeleteError("");
    setDeleting(true);
    try {
      await axios.delete(`${API_URL}/account`, { data: { confirmEmail, password: deletePassword } });
      setDeleted(true);
      await logout();
      router.push("/");
    } catch (err) {
      setDeleteError(apiError(err, t("account.deleteFailed")));
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 md:py-10">
      <h1 className="text-3xl md:text-4xl">{t("account.title")}</h1>
      <ErrorText>{error}</ErrorText>
      <SuccessText>{notice}</SuccessText>

      <Section title={t("account.profile")}>
        <p>
          <span className="muted">{t("account.emailLabel")}</span> {user.email}
        </p>
        {user.emailVerified ? (
          <p>{t("account.confirmed")}</p>
        ) : (
          <div className="space-y-3">
            <p>{t("account.notConfirmed")}</p>
            <SecondaryButton onClick={resendVerification}>{t("account.resendConfirmation")}</SecondaryButton>
          </div>
        )}
      </Section>

      {usage && (
        <Section title={t("account.usage")}>
          <UsageMeter label={t("account.summaries")} used={usage.summaries.used} limit={usage.summaries.limit} />
          <UsageMeter label={t("account.chatQuestions")} used={usage.chats.used} limit={usage.chats.limit} />
          <p className="muted text-sm">{t("account.limitsReset")}</p>
        </Section>
      )}

      <Section title={t("account.instructionsTitle")}>
        <InstructionsForm initial={user.customInstructions ?? ""} onSaved={refresh} />
      </Section>

      <Section title={t("account.passwordTitle")}>
        {user.hasPassword ? (
          <form onSubmit={changePassword} className="space-y-4">
            <Field
              id="current-password"
              label={t("account.currentPassword")}
              type="password"
              value={currentPassword}
              onChange={setCurrentPassword}
              autoComplete="current-password"
            />
            <Field
              id="new-password"
              label={t("reset.newPassword")}
              type="password"
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              minLength={8}
              maxLength={72}
              hint={t("account.newPasswordHint")}
            />
            <ErrorText>{passwordError}</ErrorText>
            <SuccessText>{passwordMessage}</SuccessText>
            <SecondaryButton type="submit">{t("account.changePassword")}</SecondaryButton>
          </form>
        ) : (
          <p>
            {t("account.googleNoPassword")}{" "}
            <a href="/forgot-password" className="text-accent underline underline-offset-2">
              {t("account.forgotLink")}
            </a>
            .
          </p>
        )}
      </Section>

      <Section title={t("twoFactor.title")}>
        <TwoFactor />
      </Section>

      <Section title={t("emails.title")}>
        <EmailPreferences />
      </Section>

      <Section title={t("account.devices")}>
        <ul className="space-y-3">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 border-b border-ink/15 pb-3 last:border-0">
              <div>
                <p>
                  {deviceName(s.userAgent, t)}
                  {s.current && <span className="chip pointer-events-none ml-2 text-xs">{t("account.thisDevice")}</span>}
                </p>
                <p className="muted text-sm">{t("account.lastActive", { when: new Date(s.lastUsedAt).toLocaleString() })}</p>
              </div>
              {!s.current && <SecondaryButton onClick={() => revokeSession(s.id)}>{t("account.signOut")}</SecondaryButton>}
            </li>
          ))}
        </ul>
        <SecondaryButton onClick={signOutEverywhere}>{t("account.signOutEverywhere")}</SecondaryButton>
      </Section>

      <Section title={t("apiKeys.title")}>
        <ApiKeys />
      </Section>

      <Section title={t("account.data")}>
        <p>{t("account.dataText")}</p>
        <SecondaryButton onClick={exportData}>{t("account.download")}</SecondaryButton>
      </Section>

      <Section title={t("account.delete")}>
        <p>{t("account.deleteText")}</p>
        <form onSubmit={deleteAccount} className="space-y-4">
          <Field
            id="confirm-email"
            label={t("account.typeToConfirm", { email: user.email })}
            value={confirmEmail}
            onChange={setConfirmEmail}
            autoComplete="off"
          />
          {user.hasPassword && (
            <Field
              id="delete-password"
              label={t("account.yourPassword")}
              type="password"
              value={deletePassword}
              onChange={setDeletePassword}
              autoComplete="current-password"
            />
          )}
          <ErrorText>{deleteError}</ErrorText>
          <DangerButton type="submit" disabled={deleting}>
            {deleting ? t("account.deleting") : t("account.deleteButton")}
          </DangerButton>
        </form>
      </Section>
    </div>
  );
}
