import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { ansiColorCss, parseAnsi, parseCssColor, type Rgb } from "../lib/ansi";

function resolveBackground(): Rgb {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--card");
  return parseCssColor(value) ?? [255, 255, 255];
}

function useCardBackground(): Rgb {
  const [background, setBackground] = useState<Rgb>(resolveBackground);
  useEffect(() => {
    const observer = new MutationObserver(() => setBackground(resolveBackground()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return background;
}

export function AnsiText(props: { text: string; highlight?: string; className?: string }) {
  const background = useCardBackground();
  const segments = useMemo(() => parseAnsi(props.text), [props.text]);
  const query = (props.highlight ?? "").toLowerCase();

  const ranges: [number, number][] = [];
  if (query !== "") {
    const plain = segments.map((segment) => segment.text).join("");
    const lower = plain.toLowerCase();
    let index = lower.indexOf(query);
    while (index !== -1) {
      ranges.push([index, index + query.length]);
      index = lower.indexOf(query, index + query.length);
    }
  }

  const parts: ReactNode[] = [];
  let offset = 0;
  let key = 0;
  for (const segment of segments) {
    const start = offset;
    const end = offset + segment.text.length;
    offset = end;

    let style: CSSProperties | undefined;
    if (segment.style) {
      style = {};
      if (segment.style.color) {
        style.color = ansiColorCss(segment.style.color, background);
      }
      if (segment.style.bold) {
        style.fontWeight = 700;
      }
      if (segment.style.italic) {
        style.fontStyle = "italic";
      }
      if (segment.style.underline) {
        style.textDecoration = "underline";
      }
    }

    const overlapping = ranges.filter(([from, to]) => to > start && from < end);
    let content: ReactNode;
    if (overlapping.length === 0) {
      content = segment.text;
    } else {
      const pieces: ReactNode[] = [];
      let cursor = 0;
      for (const [from, to] of overlapping) {
        const localFrom = Math.max(0, from - start);
        const localTo = Math.min(segment.text.length, to - start);
        if (localFrom > cursor) {
          pieces.push(segment.text.slice(cursor, localFrom));
        }
        pieces.push(<mark key={key++}>{segment.text.slice(localFrom, localTo)}</mark>);
        cursor = localTo;
      }
      if (cursor < segment.text.length) {
        pieces.push(segment.text.slice(cursor));
      }
      content = pieces;
    }

    if (style) {
      parts.push(
        <span key={key++} style={style}>
          {content}
        </span>,
      );
    } else {
      parts.push(<span key={key++}>{content}</span>);
    }
  }

  return <span className={props.className}>{parts}</span>;
}
