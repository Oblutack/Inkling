"use client";
import React from "react";

// Small building blocks shared by the account pages so they all look and behave the same.

interface FieldProps {
  id: string;
  label: string;
  type?: "text" | "email" | "password";
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  hint?: string;
  inputMode?: "numeric" | "text";
}

export function Field({
  id,
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  required = true,
  minLength,
  maxLength,
  hint,
  inputMode,
}: FieldProps) {
  return (
    <div className="w-full">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        className="field"
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        inputMode={inputMode}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && (
        <p id={`${id}-hint`} className="muted mt-1 text-sm">
          {hint}
        </p>
      )}
    </div>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export function PrimaryButton({ className = "", ...props }: ButtonProps) {
  return <button {...props} className={`btn btn-primary ${className}`} />;
}

export function SecondaryButton({ className = "", ...props }: ButtonProps) {
  return <button {...props} className={`btn btn-secondary ${className}`} />;
}

export function DangerButton({ className = "", ...props }: ButtonProps) {
  return <button {...props} className={`btn btn-danger ${className}`} />;
}

export function ErrorText({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="text-base font-medium text-danger" role="alert">
      {children}
    </p>
  );
}

export function SuccessText({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="text-base text-ink" role="status">
      {children}
    </p>
  );
}
