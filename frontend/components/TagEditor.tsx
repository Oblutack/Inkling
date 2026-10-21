"use client";
import { useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import { useT } from "./I18nProvider";

const MAX_TAGS = 8;
const MAX_TAG_CHARS = 30;

interface TagEditorProps {
  documentId: number;
  tags: string[];
  onChange: (tags: string[]) => void;
}

// A document's tags as removable chips, with a box to add one. Each change is saved at once.
export default function TagEditor({ documentId, tags, onChange }: TagEditorProps) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const t = useT();

  const save = async (next: string[]) => {
    setSaving(true);
    setError("");
    try {
      const response = await axios.put<{ tags: string[] }>(`${API_URL}/documents/${documentId}`, { tags: next });
      onChange(response.data.tags);
      return true;
    } catch (err) {
      setError(apiError(err, t("tags.failed")));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const tag = draft.trim().toLowerCase();
    if (!tag || tags.includes(tag)) {
      setDraft("");
      return;
    }
    if (await save([...tags, tag])) setDraft("");
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="tags">
      {tags.map((tag) => (
        <span key={tag} className="chip hover:bg-transparent">
          {tag}
          <button
            type="button"
            onClick={() => save(tags.filter((other) => other !== tag))}
            disabled={saving}
            className="tap-extend -mr-1.5 flex h-5 w-5 items-center justify-center rounded-full text-ink/70 transition-colors hover:bg-ink/10 hover:text-danger"
            aria-label={t("tags.remove", { tag })}
          >
            {/* Drawn, not typed: the cross of a font sits a little low in its circle. */}
            <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
            </svg>
          </button>
        </span>
      ))}
      {tags.length < MAX_TAGS && (
        <form onSubmit={add}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_TAG_CHARS}
            placeholder={t("tags.placeholder")}
            aria-label={t("tags.add")}
            // The same height as the tags next to it; the word is in the middle until something is typed.
            className={`h-[26px] w-20 rounded-full border border-dashed border-ink/40 bg-transparent px-3 text-sm focus:w-28 focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:!min-h-[40px] ${
              draft ? "text-left" : "text-center"
            } transition-[width] duration-200`}
          />
        </form>
      )}
      {error && (
        <span className="text-sm font-medium text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
