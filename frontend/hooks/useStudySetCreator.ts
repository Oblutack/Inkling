"use client";
import { useRef, useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import { isImageFile } from "../lib/links";
import { shrinkPhoto } from "../lib/photos";
import { useT } from "../components/I18nProvider";

interface Source {
  files: File[];
  text: string;
  // Set when the text box holds just a web address.
  link: string | null;
}

// Makes a study set (flashcards, with no summary) from what is in the input box: pasted text, a web address or
// uploaded files. The server reads the document, writes the cards and saves it all, then says which document it is.
export function useStudySetCreator(onCreated: (id: number) => void) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const create = async ({ files, text, link }: Source): Promise<boolean> => {
    setError("");
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let id: number;
      if (files.length > 0) {
        // Big photos are made smaller first, as for a summary.
        const uploads = await Promise.all(files.map((f) => (isImageFile(f.name) ? shrinkPhoto(f) : f)));
        const form = new FormData();
        uploads.forEach((f) => form.append("files", f));
        id = (await axios.post<{ id: number }>(`${API_URL}/study-sets/files`, form, { signal: controller.signal })).data.id;
      } else if (link) {
        id = (await axios.post<{ id: number }>(`${API_URL}/study-sets/url`, { url: link }, { signal: controller.signal })).data.id;
      } else {
        id = (await axios.post<{ id: number }>(`${API_URL}/study-sets/text`, { text }, { signal: controller.signal })).data.id;
      }
      onCreated(id);
      return true;
    } catch (err) {
      // Pressing Cancel is not a failure.
      if (!axios.isCancel(err)) setError(apiError(err, t("form.studyFailed")));
      return false;
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  };

  return { create, cancel: () => abortRef.current?.abort(), loading, error, clearError: () => setError("") };
}
