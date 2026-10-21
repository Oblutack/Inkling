// A ring and a tick that draw themselves: for the moment something has been done (a mail sent, a password changed, a review finished).
// Decorative; the words next to it say what happened.
export default function DrawnCheck({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 52 52" className={`mx-auto h-14 w-14 text-accent ${className}`} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="26" cy="26" r="23" pathLength={1} className="draw" style={{ animationDuration: "0.8s", animationDelay: "0.1s" }} />
      <path d="M15.5 27l7.5 7.5 14-16" pathLength={1} className="draw" style={{ animationDuration: "0.5s", animationDelay: "0.65s" }} />
    </svg>
  );
}
