// An original PDF kept with a saved summary.
export interface FileInfo {
  id: number;
  name: string;
  size: number;
}

export interface Document {
  ID: number;
  CreatedAt: string;
  Filename: string;
  Summary: string;
  hasContent?: boolean;
  // Labels the owner put on it, lowercase.
  tags: string[];
  // Set while the summary has a public link (the part after /s/ in the address).
  shareToken?: string;
  // Empty for pasted text and for documents saved before originals were kept.
  files?: FileInfo[];
}

// A passage of the document that an answer cites.
export interface ChatSource {
  id: number;
  text: string;
  // Pages are counted within each file; null when the document has no page information.
  page: number | null;
  pageEnd: number | null;
  // The file name, when several files were summarized together.
  document?: string;
  // Only on answers drawn from the whole library: which saved document the passage is in, when it was
  // saved, and the stored original PDF to open it in (if one was kept).
  documentId?: number;
  documentTitle?: string;
  savedAt?: string;
  fileId?: number | null;
  fileName?: string;
}

// How well a sentence of a summary is backed by the original document (see the proof check).
export type Support = "strong" | "weak" | "none";

export interface ProofPassage {
  id: number;
  text: string;
  page: number | null;
  pageEnd: number | null;
  document?: string;
  coverage: number;
}

export interface ProofSentence {
  text: string;
  kind: "claim" | "heading";
  // null for headings, which are not judged.
  support: Support | null;
  coverage: number;
  // Numbers in the sentence that the document never mentions, and ones it has but elsewhere.
  missingNumbers: string[];
  elsewhereNumbers: string[];
  passages: ProofPassage[];
}

export interface ProofResult {
  sentences: ProofSentence[];
  claims: number;
  found: number;
  partly: number;
  notFound: number;
  // False when almost nothing matched: the summary is probably in another language than the document.
  verifiable: boolean;
}

// A podcast script: a short conversation between two hosts, A and B, about a document.
export interface PodcastTurn {
  speaker: "A" | "B";
  text: string;
}

export interface PodcastScript {
  title: string;
  // The language the script was written in; empty means that of the document.
  language: string;
  turns: PodcastTurn[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  // Only on assistant messages: the passages the answer cites.
  sources?: ChatSource[];
}

export interface User {
  id: number;
  email: string;
  emailVerified: boolean;
  // False for accounts created through Google sign-in until they set a password.
  hasPassword: boolean;
  // Standing preferences added to every summary ("focus on costs and deadlines").
  customInstructions: string;
  // Whether signing in needs a code from an authenticator app too, and whether this server can offer that at all.
  twoFactorEnabled: boolean;
  twoFactorAvailable: boolean;
}

// A flashcard, and a multiple-choice question of a quiz made from a document.
export interface StudyCard {
  front: string;
  back: string;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  // Which of the options is right.
  answer: number;
  explanation: string;
}

export interface SessionInfo {
  id: number;
  current: boolean;
  userAgent: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface Usage {
  summaries: { used: number; limit: number };
  chats: { used: number; limit: number };
  resetsAt: string;
}
