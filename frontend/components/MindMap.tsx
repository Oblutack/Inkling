"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { API_URL, apiError } from "../lib/api";
import { buildTree, edgePath, layoutTree, sentenceForPoint, toSvg, type MapNode, type PlacedNode } from "../lib/mindmap";
import { fileForPassage, supportLabel, supportMark } from "../lib/proof";
import { safeFileName } from "../lib/markdownText";
import type { Document, FileInfo, ProofPassage, ProofResult } from "../types";
import { useT } from "./I18nProvider";
import { actionButton } from "./styles";

interface MindMapProps {
  doc: Document;
  // The original PDFs kept with the document: they make the source of a point openable.
  files: FileInfo[];
  onOpenDocument: (file: FileInfo, passage: ProofPassage) => void;
}

interface View {
  // The top left corner of what is shown, in the units of the picture, and how far it is zoomed in.
  x: number;
  y: number;
  zoom: number;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;

function Outline({ node }: { node: MapNode }) {
  return (
    <li>
      {node.text}
      {node.children.length > 0 && (
        <ul className="ml-5 list-disc space-y-1">
          {node.children.map((child) => (
            <Outline key={child.id} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

// A mind map of a summary: its title in the middle, headings as branches, points as leaves. It can be moved and zoomed, a
// point can be selected to read it in full and see the passage of the document it came from, and the picture can be saved.
export default function MindMap({ doc, files, onOpenDocument }: MindMapProps) {
  const t = useT();
  const title = doc.Filename.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const tree = useMemo(() => buildTree(title, doc.Summary), [title, doc.Summary]);
  const layout = useMemo(() => layoutTree(tree), [tree]);

  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [selected, setSelected] = useState<PlacedNode | null>(null);
  const [proof, setProof] = useState<ProofResult | null>(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [error, setError] = useState("");
  const frame = useRef<HTMLDivElement | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The part of the picture that is shown: all of it, or less when zoomed in.
  const box = { width: layout.width / view.zoom, height: layout.height / view.zoom };

  const fit = () => setView({ x: 0, y: 0, zoom: 1 });

  // Zoom around the middle of what is shown.
  const zoomBy = (factor: number) =>
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const centreX = v.x + layout.width / v.zoom / 2;
      const centreY = v.y + layout.height / v.zoom / 2;
      return { zoom, x: centreX - layout.width / zoom / 2, y: centreY - layout.height / zoom / 2 };
    });

  // Scrolling the page must keep working, so the wheel only zooms with Ctrl (or ⌘) held, as pinching does. The listener is
  // added by hand because React's wheel handlers cannot cancel the page's own zoom.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });

  // How many units of the picture a screen pixel covers (the picture is fitted into the frame, so the larger ratio rules).
  const unitsPerPixel = () => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return 1;
    return Math.max(box.width / rect.width, box.height / rect.height);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, view, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const start = drag.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    start.moved = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const k = unitsPerPixel();
    setView({ ...start.view, x: start.view.x - dx * k, y: start.view.y - dy * k });
  };
  const onPointerUp = () => {
    // a click that ends a drag must not select the point under the pointer
    setTimeout(() => (drag.current = null), 0);
  };

  // Moves the view so a point that has taken the keyboard focus is in sight.
  const reveal = (n: PlacedNode) => {
    setView((v) => {
      const w = layout.width / v.zoom;
      const h = layout.height / v.zoom;
      const inX = n.x >= v.x && n.x + n.width <= v.x + w;
      const inY = n.y >= v.y && n.y + n.height <= v.y + h;
      if (inX && inY) return v;
      return { ...v, x: n.x + n.width / 2 - w / 2, y: n.y + n.height / 2 - h / 2 };
    });
  };

  const choose = (n: PlacedNode) => {
    if (drag.current?.moved) return;
    setSelected(n);
  };

  const loadProof = async () => {
    setProofLoading(true);
    setError("");
    try {
      const response = await axios.post<ProofResult>(`${API_URL}/documents/${doc.ID}/proof`);
      if (alive.current) setProof(response.data);
    } catch (err) {
      if (alive.current) setError(apiError(err, t("map.sourceFailed")));
    } finally {
      if (alive.current) setProofLoading(false);
    }
  };

  const fileName = (extension: string) => `${safeFileName(title, "mind-map")}-map.${extension}`;

  const save = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadSvg = () => save(new Blob([toSvg(layout, title)], { type: "image/svg+xml;charset=utf-8" }), fileName("svg"));

  // A picture file: the same drawing, twice as sharp as it is on screen.
  const downloadPng = () => {
    const url = URL.createObjectURL(new Blob([toSvg(layout, title)], { type: "image/svg+xml;charset=utf-8" }));
    const image = new Image();
    image.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(layout.width * scale);
      canvas.height = Math.ceil(layout.height * scale);
      const context = canvas.getContext("2d");
      if (context) {
        context.scale(scale, scale);
        context.drawImage(image, 0, 0, layout.width, layout.height);
        canvas.toBlob((blob) => blob && save(blob, fileName("png")), "image/png");
      }
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setError(t("map.pictureFailed"));
    };
    image.src = url;
  };

  const sentence = selected && proof ? sentenceForPoint(selected.node.text, proof.sentences) : null;
  const passage = sentence?.passages[0];
  const pdf = passage ? fileForPassage(files, passage) : undefined;

  return (
    <section className="mt-4 border-t border-ink/15 pt-4" aria-label={t("map.title")} data-testid="mind-map">
      <h4 className="text-lg font-semibold">{t("map.title")}</h4>
      <p className="muted mt-1 text-sm">{t("map.intro")}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => zoomBy(1.25)} className={actionButton}>
          {t("map.zoomIn")}
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.25)} className={actionButton}>
          {t("map.zoomOut")}
        </button>
        <button type="button" onClick={fit} className={actionButton}>
          {t("map.fit")}
        </button>
        <button type="button" onClick={downloadSvg} className={actionButton}>
          {t("map.downloadSvg")}
        </button>
        <button type="button" onClick={downloadPng} className={actionButton}>
          {t("map.downloadPng")}
        </button>
      </div>

      <div
        ref={frame}
        className="mt-3 h-[26rem] w-full touch-none select-none overflow-hidden rounded-xl border border-ink/20 bg-surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        data-testid="map-frame"
      >
        <svg
          ref={svg}
          viewBox={`${view.x} ${view.y} ${box.width} ${box.height}`}
          className="h-full w-full cursor-grab active:cursor-grabbing"
          role="group"
          aria-label={t("map.aria", { title })}
          data-zoom={view.zoom.toFixed(2)}
        >
          <g fill="none" className="stroke-ink/40" strokeWidth={1.5}>
            {layout.nodes
              .filter((n) => n.parent !== null)
              .map((n, i) => (
                // Drawn from the parent to the child, one after the other (the delay stops growing after a while, so a big map is quick too).
                <path key={n.node.id} d={edgePath(layout.nodes[n.parent as number], n)} pathLength={1} className="draw" style={{ "--i": Math.min(i, 16) } as React.CSSProperties} />
              ))}
          </g>
          {layout.nodes.map((n, index) => {
            const root = n.node.kind === "root";
            const branch = n.node.kind === "branch";
            const isSelected = selected?.node.id === n.node.id;
            return (
              <g
                key={n.node.id}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-describedby={n.lines.join(" ") !== n.node.text ? `map-full-${n.node.id}` : undefined}
                data-testid="map-node"
                data-kind={n.node.kind}
                className="pop cursor-pointer outline-none [transform-box:fill-box] [transform-origin:center] [&:focus-visible>rect]:stroke-[3]"
                style={{ "--i": Math.min(index, 16), "--wait": "120ms" } as React.CSSProperties}
                onClick={() => choose(n)}
                onFocus={() => reveal(n)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(n);
                  }
                }}
              >
                <rect
                  x={n.x}
                  y={n.y}
                  width={n.width}
                  height={n.height}
                  rx={10}
                  strokeWidth={isSelected ? 3 : root || branch ? 1.5 : 1}
                  className={`${root ? "fill-accent stroke-accent" : branch ? "fill-accent/10 stroke-accent" : "fill-canvas stroke-ink/40"} ${isSelected ? "stroke-ink" : ""}`}
                />
                {n.lines.map((line, i) => (
                  <text
                    key={i}
                    x={n.x + 12}
                    y={n.y + 10 + 17 * (i + 0.78)}
                    fontSize={14}
                    fontWeight={root || branch ? 600 : 400}
                    className={root ? "fill-accent-fg" : "fill-ink"}
                  >
                    {/* The button is named by the words drawn on it (a space ends each line, so the lines read as one sentence).
                        Where the drawn words are cut short, the whole text is its description. */}
                    {line}
                    {i < n.lines.length - 1 ? " " : ""}
                  </text>
                ))}
                {n.lines.join(" ") !== n.node.text && <desc id={`map-full-${n.node.id}`}>{n.node.text}</desc>}
              </g>
            );
          })}
        </svg>
      </div>
      <p className="muted mt-2 text-sm">{t("map.hint")}</p>
      {tree.omitted > 0 && <p className="muted mt-1 text-sm">{t("map.omitted", { n: tree.omitted })}</p>}

      {error && (
        <p className="mt-2 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="mt-3" aria-live="polite" data-testid="map-detail">
        {selected ? (
          <div className="rounded-xl border border-ink/20 p-3">
            <p className="text-base font-semibold">{selected.node.text}</p>
            {doc.hasContent && selected.node.kind !== "root" && (
              <div className="mt-2">
                {!proof ? (
                  <button type="button" onClick={() => void loadProof()} disabled={proofLoading} className={actionButton}>
                    {proofLoading ? t("map.sourceLoading") : t("map.showSource")}
                  </button>
                ) : sentence?.passages.length && passage ? (
                  <div data-testid="map-source">
                    <p className="text-sm font-medium">
                      <span role="img" aria-label={sentence.support ? supportLabel(sentence.support, t) : ""}>
                        {sentence.support ? supportMark(sentence.support) : ""}
                      </span>{" "}
                      {t("map.source")}
                      {passage.page != null ? ` (${t("source.page", { n: passage.page })})` : ""}
                    </p>
                    <blockquote className="mt-1 border-l-2 border-ink/30 pl-3 text-sm">{passage.text}</blockquote>
                    {pdf && (
                      <button type="button" onClick={() => onOpenDocument(pdf, passage)} className={`${actionButton} mt-2`}>
                        {t("map.openPage")}
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="muted text-sm" data-testid="map-source-none">
                    {sentence?.kind === "heading" ? t("map.sourceHeading") : t("map.sourceNone")}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="muted text-sm">{t("map.selectHint")}</p>
        )}
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">{t("map.outline")}</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-base" data-testid="map-outline">
          <Outline node={tree.root} />
        </ul>
      </details>
    </section>
  );
}
