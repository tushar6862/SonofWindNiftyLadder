import { memo, useLayoutEffect, useRef } from "react";
import { peekLiveLtp, subscribeLiveLtp } from "@/context/LiveLtpContext";

/** Last-trade paint without React children so engine clocks cannot clobber ticks. */
export const FastLtp = memo(function FastLtp({
  iid,
  className,
  as: Tag = "span",
}: {
  iid: number | null | undefined;
  className?: string;
  as?: "span" | "div";
}) {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (iid == null || !Number.isFinite(iid) || iid <= 0) {
      el.textContent = "—";
      return;
    }
    const cur = peekLiveLtp(iid);
    el.textContent = cur != null ? cur.toFixed(2) : "—";
    return subscribeLiveLtp(iid, (px) => {
      el.textContent = px.toFixed(2);
    });
  }, [iid]);
  return <Tag ref={ref as never} className={className} />;
});
