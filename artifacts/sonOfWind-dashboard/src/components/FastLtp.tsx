import { memo, useLayoutEffect, useRef } from "react";
import { peekLiveLtp, subscribeLiveLtp } from "@/context/LiveLtpContext";

/** Last-trade paint without React children so engine clocks cannot clobber ticks. */
export const FastLtp = memo(function FastLtp({
  iid,
  className,
  as: Tag = "span",
  min = 0,
}: {
  iid: number | null | undefined;
  className?: string;
  as?: "span" | "div";
  /** Ignore prints below this (index spot must not paint an option tick). */
  min?: number;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const paint = (px: number | null) => {
      const node = ref.current;
      if (!node) return;
      if (px == null || !Number.isFinite(px) || px < min) {
        const cur = Number(node.textContent);
        if (!(cur >= min)) node.textContent = "—";
        return;
      }
      node.textContent = px.toFixed(2);
    };
    if (iid == null || !Number.isFinite(iid) || iid <= 0) {
      el.textContent = "—";
      return;
    }
    paint(peekLiveLtp(iid));
    return subscribeLiveLtp(iid, paint);
  }, [iid, min]);
  return <Tag ref={ref as never} className={className} />;
});
