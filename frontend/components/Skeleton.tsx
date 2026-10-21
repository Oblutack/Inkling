"use client";
import { useT } from "./I18nProvider";

// Grey placeholder shapes shown while something loads, so the page does not jump or look empty.

export function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`shimmer h-4 rounded bg-ink/10 ${className}`} aria-hidden="true" />;
}

// Stands in for a saved summary while the list loads.
export function DocumentSkeleton() {
  return (
    <div className="card" aria-hidden="true" data-testid="document-skeleton">
      <SkeletonLine className="h-7 w-1/2" />
      <SkeletonLine className="mt-3 w-1/4" />
      <div className="mt-6 space-y-3">
        <SkeletonLine className="w-full" />
        <SkeletonLine className="w-11/12" />
        <SkeletonLine className="w-5/6" />
      </div>
    </div>
  );
}

// A group of them, announced once to screen readers.
export function DocumentListSkeleton({ count = 3 }: { count?: number }) {
  const t = useT();
  return (
    <div className="space-y-6" role="status">
      <span className="sr-only">{t("skeleton.loading")}</span>
      {Array.from({ length: count }, (_, i) => (
        <DocumentSkeleton key={i} />
      ))}
    </div>
  );
}
