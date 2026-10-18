import type { MetadataRoute } from "next";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS } from "../lib/links";

// What can be shared to Inkling as a file: the documents, photos and recordings it can read. (Types and extensions both:
// phones tell which, and not always the same way.)
const SHARED_FILE_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "audio/*",
  "video/mp4",
  ".pdf",
  ".docx",
  ".pptx",
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
];

// What a browser needs to offer "Install Inkling": a name, icons and how to open it.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Inkling",
    short_name: "Inkling",
    description: "Read, question and verify your documents. Every answer shows its source.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#e6e5d6",
    theme_color: "#e6e5d6",
    // "Inkling" in the phone's Share menu: a link, some text or files are sent to /share-target (see public/sw.js).
    // The manifest type calls the files entry a File; browsers expect a list of {name, accept}.
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: { title: "title", text: "text", url: "url", files: [{ name: "files", accept: SHARED_FILE_TYPES }] },
    } as unknown as MetadataRoute.Manifest["share_target"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
