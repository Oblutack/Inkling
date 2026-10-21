// The title of a page, with a short stroke of ink drawn under it. The margin below is the caller's (className).
export default function PageTitle({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <h1 className="text-3xl md:text-4xl">{children}</h1>
      <span className="ink-rule mt-2" aria-hidden="true" />
    </div>
  );
}
