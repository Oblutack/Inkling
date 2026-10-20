// A page eases in when it opens. It is done with CSS, not with JavaScript: a script-driven fade starts the page invisible and shows it
// only after all the scripts have loaded, which on a phone with a slow connection is a blank screen. The CSS fade starts at once.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
