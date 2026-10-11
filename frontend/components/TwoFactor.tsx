"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import QRCode from "qrcode";
import { useAuth } from "../contexts/AuthContext";
import { API_URL, apiError } from "../lib/api";
import { RECOVERY_FILE_NAME, cleanCode, recoveryFileText } from "../lib/twoFactor";
import CopyButton from "./CopyButton";
import { useT } from "./I18nProvider";
import { DangerButton, ErrorText, Field, PrimaryButton, SecondaryButton, SuccessText } from "./ui";

interface Status {
  available: boolean;
  enabled: boolean;
  recoveryCodesLeft?: number;
}

type Step =
  | { name: "idle" }
  | { name: "password" }
  | { name: "scan"; secret: string; url: string }
  | { name: "codes"; codes: string[] }
  | { name: "turnOff" }
  | { name: "newCodes" };

// Two-step sign-in: set up with an authenticator app, kept with recovery codes, switched off again. The server asks for the
// password again for each of these, since they change how the account is guarded.
export default function TwoFactor() {
  const t = useT();
  const { user, refresh } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState<Step>({ name: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await axios.get<Status>(`${API_URL}/account/two-factor`);
      setStatus(response.data);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The QR code is drawn here in the browser: the secret is never sent to anyone else to be turned into a picture.
  useEffect(() => {
    if (step.name !== "scan") {
      setQr("");
      return;
    }
    let current = true;
    QRCode.toDataURL(step.url, { margin: 1, width: 200, errorCorrectionLevel: "M" })
      .then((dataUrl) => current && setQr(dataUrl))
      .catch(() => current && setQr(""));
    return () => {
      current = false;
    };
  }, [step]);

  const reset = (next: Step = { name: "idle" }) => {
    setStep(next);
    setPassword("");
    setCode("");
    setUseRecovery(false);
    setError("");
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (err) {
      setError(apiError(err, t("twoFactor.failed")));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  if (!status.available && !status.enabled) {
    return (
      <p className="muted" data-testid="two-factor-unavailable">
        {t("twoFactor.unavailable")}
      </p>
    );
  }

  const passwordField = user?.hasPassword ? (
    <Field id="two-factor-password" label={t("twoFactor.passwordLabel")} type="password" value={password} onChange={setPassword} autoComplete="current-password" />
  ) : null;

  const startSetup = () =>
    run(async () => {
      const response = await axios.post<{ secret: string; otpauthUrl: string }>(`${API_URL}/account/two-factor/setup`, { password });
      setPassword("");
      setStep({ name: "scan", secret: response.data.secret, url: response.data.otpauthUrl });
    });

  const begin = (e: React.FormEvent) => {
    e.preventDefault();
    void startSetup();
  };

  const finish = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const response = await axios.post<{ recoveryCodes: string[] }>(`${API_URL}/account/two-factor/enable`, { code: cleanCode(code) });
      setCode("");
      setStep({ name: "codes", codes: response.data.recoveryCodes });
      await load();
      await refresh();
    });
  };

  const turnOff = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await axios.post(`${API_URL}/account/two-factor/disable`, useRecovery ? { password, recoveryCode: code.trim() } : { password, code: cleanCode(code) });
      reset();
      setMessage(t("twoFactor.disabled"));
      await load();
      await refresh();
    });
  };

  const newCodes = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const response = await axios.post<{ recoveryCodes: string[] }>(`${API_URL}/account/two-factor/recovery-codes`, { password, code: cleanCode(code) });
      reset({ name: "codes", codes: response.data.recoveryCodes });
      await load();
    });
  };

  const download = (codes: string[]) => {
    const blob = new Blob([recoveryFileText(user?.email ?? "", codes)], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = RECOVERY_FILE_NAME;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="space-y-4" data-testid="two-factor">
      <p>{t("twoFactor.intro")}</p>
      <ErrorText>{error}</ErrorText>
      <SuccessText>{message}</SuccessText>

      {step.name === "codes" && (
        <div className="space-y-3 rounded-lg border border-accent/60 bg-surface p-4" role="group" aria-label={t("twoFactor.recoveryTitle")} data-testid="recovery-codes">
          <h3 className="text-lg font-semibold">{t("twoFactor.recoveryTitle")}</h3>
          <p className="text-sm">{t("twoFactor.recoveryText")}</p>
          <ul className="grid grid-cols-2 gap-2 font-mono text-base sm:max-w-sm">
            {step.codes.map((c) => (
              <li key={c} data-testid="recovery-code">
                {c}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <CopyButton text={step.codes.join("\n")} what={t("twoFactor.recoveryTitle")} />
            <SecondaryButton type="button" onClick={() => download(step.codes)}>
              {t("twoFactor.recoveryDownload")}
            </SecondaryButton>
            <PrimaryButton type="button" onClick={() => reset()}>
              {t("twoFactor.recoverySaved")}
            </PrimaryButton>
          </div>
        </div>
      )}

      {!status.enabled && step.name === "idle" && (
        <>
          <p role="status">{t("twoFactor.off")}</p>
          <PrimaryButton
            type="button"
            onClick={() => {
              setMessage("");
              // an account made through Google has no password to ask for
              if (user?.hasPassword) setStep({ name: "password" });
              else void startSetup();
            }}
          >
            {t("twoFactor.turnOn")}
          </PrimaryButton>
        </>
      )}

      {!status.enabled && step.name === "password" && (
        <form onSubmit={begin} className="space-y-3">
          {passwordField}
          <div className="flex gap-3">
            <PrimaryButton type="submit" disabled={busy}>
              {t("twoFactor.start")}
            </PrimaryButton>
            <SecondaryButton type="button" onClick={() => reset()}>
              {t("twoFactor.cancel")}
            </SecondaryButton>
          </div>
        </form>
      )}

      {!status.enabled && step.name === "scan" && (
        <form onSubmit={finish} className="space-y-4">
          <p>{t("twoFactor.scan")}</p>
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt={t("twoFactor.qrAlt")} width={200} height={200} className="rounded-lg border border-ink/20 bg-white" data-testid="two-factor-qr" />
          )}
          <div>
            <p className="label">{t("twoFactor.manualKey")}</p>
            <code className="block break-all rounded-md bg-canvas px-3 py-2 text-sm" data-testid="two-factor-secret">
              {step.secret.replace(/(.{4})/g, "$1 ").trim()}
            </code>
          </div>
          <Field id="two-factor-code" label={t("twoFactor.codeLabel")} value={code} onChange={setCode} autoComplete="one-time-code" inputMode="numeric" maxLength={8} />
          <div className="flex gap-3">
            <PrimaryButton type="submit" disabled={busy}>
              {t("twoFactor.confirm")}
            </PrimaryButton>
            <SecondaryButton type="button" onClick={() => reset()}>
              {t("twoFactor.cancel")}
            </SecondaryButton>
          </div>
        </form>
      )}

      {status.enabled && step.name === "idle" && (
        <>
          <p role="status" data-testid="two-factor-on">
            {t("twoFactor.on")}
            {typeof status.recoveryCodesLeft === "number" && (
              <>
                {" "}
                <span className="muted" data-testid="recovery-left">
                  {t("twoFactor.recoveryLeft", { n: status.recoveryCodesLeft })}
                </span>
              </>
            )}
          </p>
          <div className="flex flex-wrap gap-3">
            <SecondaryButton type="button" onClick={() => { setMessage(""); reset({ name: "newCodes" }); }}>
              {t("twoFactor.newCodes")}
            </SecondaryButton>
            <DangerButton type="button" onClick={() => { setMessage(""); reset({ name: "turnOff" }); }}>
              {t("twoFactor.turnOff")}
            </DangerButton>
          </div>
        </>
      )}

      {status.enabled && step.name === "newCodes" && (
        <form onSubmit={newCodes} className="space-y-3">
          <p>{t("twoFactor.newCodesText")}</p>
          {passwordField}
          <Field id="two-factor-code" label={t("twoFactor.codeLabel")} value={code} onChange={setCode} autoComplete="one-time-code" inputMode="numeric" maxLength={8} />
          <div className="flex gap-3">
            <PrimaryButton type="submit" disabled={busy}>
              {t("twoFactor.newCodes")}
            </PrimaryButton>
            <SecondaryButton type="button" onClick={() => reset()}>
              {t("twoFactor.cancel")}
            </SecondaryButton>
          </div>
        </form>
      )}

      {status.enabled && step.name === "turnOff" && (
        <form onSubmit={turnOff} className="space-y-3">
          <p>{t("twoFactor.turnOffText")}</p>
          {passwordField}
          <Field
            id="two-factor-code"
            label={useRecovery ? t("twoFactor.recoveryCodeLabel") : t("twoFactor.codeLabel")}
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            inputMode={useRecovery ? "text" : "numeric"}
            maxLength={16}
          />
          <button type="button" className="text-sm text-accent underline underline-offset-2" onClick={() => { setUseRecovery(!useRecovery); setCode(""); }}>
            {useRecovery ? t("twoFactor.useApp") : t("twoFactor.useRecovery")}
          </button>
          <div className="flex gap-3">
            <DangerButton type="submit" disabled={busy}>
              {t("twoFactor.turnOff")}
            </DangerButton>
            <SecondaryButton type="button" onClick={() => reset()}>
              {t("twoFactor.cancel")}
            </SecondaryButton>
          </div>
        </form>
      )}
    </div>
  );
}
