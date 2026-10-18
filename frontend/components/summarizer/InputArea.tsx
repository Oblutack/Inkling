"use client";
import { useEffect, useState } from "react";
import { SAMPLE_TEXT } from "../../lib/sampleText";
import { DOCUMENT_EXTENSIONS, isAudioFile, isImageFile } from "../../lib/links";
import { MAX_FILES } from "../../lib/summaryOptions";
import AudioPlayer from "../AudioPlayer";
import Recorder from "../Recorder";
import { useT } from "../I18nProvider";

interface InputAreaProps {
  files: File[];
  text: string;
  // Set when the text box holds just a web address.
  link?: string | null;
  // What to tell the person about a web address, when it is not about summarizing (a study set, say).
  linkHint?: string;
  // Set when a recording is attached.
  hasAudio?: boolean;
  // Set when a photo is attached.
  hasPhotos?: boolean;
  // Whether the microphone and the camera can be offered: recordings and photos are for signed-in people.
  canRecord?: boolean;
  onTextChange: (value: string) => void;
  onFilesPicked: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  onMoveFile: (index: number, by: -1 | 1) => void;
}

// A recording that was picked or made can be played before it is summarized, to check it is the right one and that it
// can be heard. The player's address is made from the file in this browser and let go of afterwards: nothing is sent.
function AudioPreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file]);
  return url ? <AudioPlayer src={url} label={file.name} /> : null;
}

// A small picture of an attached photo, so the right page is easy to tell from the others. Like the audio player,
// its address is made from the file in this browser and let go of afterwards: nothing is sent.
function PhotoThumbnail({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  const [unreadable, setUnreadable] = useState(false);
  useEffect(() => {
    const made = URL.createObjectURL(file);
    setUrl(made);
    setUnreadable(false);
    return () => URL.revokeObjectURL(made);
  }, [file]);
  // A picture this browser cannot draw (an iPhone's HEIC, outside Safari) is still sent and read by the server; it just
  // has a plain tile instead of a thumbnail, and the file name beside it says what it is.
  if (!url) return null;
  if (unreadable) {
    return (
      <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-md border border-ink/20 bg-ink/5 text-ink/50" data-testid="photo-thumbnail" aria-hidden="true">
        <CameraIcon />
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" onError={() => setUnreadable(true)} className="h-12 w-12 flex-shrink-0 rounded-md border border-ink/20 object-cover" data-testid="photo-thumbnail" />;
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
    </svg>
  );
}

// The place to put the words: a text box that also takes PDFs. Once PDFs are attached they replace the
// text box with a list, since a summary comes from one or the other.
export default function InputArea({ files, text, link, linkHint, hasAudio, hasPhotos, canRecord, onTextChange, onFilesPicked, onRemoveFile, onMoveFile }: InputAreaProps) {
  const t = useT();
  // Whether the main pointer is a finger (a phone or tablet) is only known in the browser. There the camera can be
  // offered; on a computer the Attach button already offers the picture files.
  const [touchScreen, setTouchScreen] = useState(false);
  useEffect(() => setTouchScreen(window.matchMedia("(pointer: coarse)").matches), []);
  const canTakePhoto = Boolean(canRecord) && touchScreen;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow picking the same file again after removing it
    onFilesPicked(picked);
  };

  return (
    <div className="rounded-xl border border-ink/40 bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
      {files.length > 0 ? (
        <ul className="space-y-2 p-3">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${f.size}`}
              className="rounded-lg border border-ink/20 bg-canvas/60 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
              {isImageFile(f.name) && <PhotoThumbnail file={f} />}
              <span className="min-w-0 flex-1 truncate text-base font-medium" title={f.name}>
                {f.name}
              </span>
              {files.length > 1 && (
                <span className="flex flex-shrink-0 flex-col">
                  <button
                    type="button"
                    onClick={() => onMoveFile(i, -1)}
                    disabled={i === 0}
                    className="flex h-5 w-9 items-center justify-center rounded-md text-xs leading-none text-ink/70 hover:bg-ink/10 disabled:opacity-30"
                    aria-label={t("form.moveUpNamed", { name: f.name })}
                    title={t("form.moveUpNamed", { name: f.name })}
                  >
                    &#9650;
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveFile(i, 1)}
                    disabled={i === files.length - 1}
                    className="flex h-5 w-9 items-center justify-center rounded-md text-xs leading-none text-ink/70 hover:bg-ink/10 disabled:opacity-30"
                    aria-label={t("form.moveDownNamed", { name: f.name })}
                    title={t("form.moveDownNamed", { name: f.name })}
                  >
                    &#9660;
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={() => onRemoveFile(i)}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-2xl leading-none text-ink/70 hover:bg-ink/10 hover:text-danger"
                title={t("form.removeFile")}
                aria-label={t("form.removeFileNamed", { name: f.name })}
              >
                &times;
              </button>
              </div>
              {isAudioFile(f.name) && (
                <div className="mt-2">
                  <AudioPreview file={f} />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        // One textarea stays mounted for the whole typing session, so focus and the first keystroke are
        // never lost to a swap between elements. The frame around it shows the focus.
        <textarea
          id="main-textarea"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          aria-label={t("form.textAria")}
          placeholder={t("form.dropHint")}
          className="block min-h-[11rem] w-full resize-y rounded-t-xl bg-transparent px-4 py-3 text-base leading-relaxed focus:outline-none"
        />
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink/15 px-2 py-1.5">
        {(files.length === 0 || files.length < MAX_FILES) && (
          <label htmlFor="pdf-upload" className="btn btn-quiet cursor-pointer gap-2">
            <PaperclipIcon />
            {files.length === 0 ? t("form.attach") : t("form.addMore")}
          </label>
        )}
        {canRecord && files.length < MAX_FILES && <Recorder onRecorded={(file) => onFilesPicked([file])} />}
        {canTakePhoto && files.length < MAX_FILES && (
          <label htmlFor="photo-capture" className="btn btn-quiet cursor-pointer gap-2">
            <CameraIcon />
            {t("form.takePhoto")}
          </label>
        )}
        {files.length === 0 && !text && (
          <button type="button" onClick={() => onTextChange(SAMPLE_TEXT)} className="btn btn-quiet underline">
            {t("form.trySample")}
          </button>
        )}
        {hasAudio && (
          <p className="px-2 text-sm font-medium text-accent" role="status" data-testid="audio-hint">
            {t("form.audioHint")}
          </p>
        )}
        {hasPhotos && (
          <p className="px-2 text-sm font-medium text-accent" role="status" data-testid="photo-hint">
            {t("form.photoHint")}
          </p>
        )}
        {link && (
          <p className="px-2 text-sm font-medium text-accent" role="status" data-testid="link-detected">
            {linkHint ?? t("form.linkDetected")}
          </p>
        )}
      </div>

      {/* Always mounted so both the empty-state and the file-list buttons can open it. */}
      <input id="pdf-upload" type="file" className="sr-only" onChange={handleFileChange} accept={DOCUMENT_EXTENSIONS.join(",")} multiple tabIndex={-1} />
      {/* Listing the formats (and not image/*) makes iPhones hand over a JPEG instead of a HEIC picture. */}
      {canTakePhoto && (
        <input id="photo-capture" type="file" className="sr-only" onChange={handleFileChange} accept="image/jpeg,image/png,image/webp" capture="environment" tabIndex={-1} />
      )}
    </div>
  );
}
