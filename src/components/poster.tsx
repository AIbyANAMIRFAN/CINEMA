/* eslint-disable @next/next/no-img-element -- remote posters come from arbitrary https hosts; a plain <img> avoids next/image remote config. */

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Movie poster: the real image when a URL exists, otherwise a deterministic gradient with title typography. */
export function Poster({
  title,
  posterUrl,
  subtitle,
  className = "",
  size = "md",
}: {
  title: string;
  posterUrl?: string | null;
  subtitle?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const base = `relative aspect-[2/3] overflow-hidden rounded-xl bg-surface-2 ${className}`;
  if (posterUrl) {
    return (
      <div className={base}>
        <img src={posterUrl} alt={`${title} poster`} className="h-full w-full object-cover" loading="lazy" />
      </div>
    );
  }
  const h = hash(title);
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + ((h >> 9) % 80)) % 360;
  const angle = 140 + ((h >> 3) % 80);
  const textSize = size === "lg" ? "text-3xl" : size === "sm" ? "text-sm" : "text-xl";
  return (
    <div
      className={base}
      role="img"
      aria-label={`${title} poster`}
      style={{
        backgroundImage: `radial-gradient(120% 80% at 80% 0%, hsl(${hue2} 70% 55% / 0.55), transparent 60%),
          linear-gradient(${angle}deg, hsl(${hue1} 55% 22%), hsl(${hue2} 60% 12%) 70%, #07070b)`,
      }}
    >
      <div
        aria-hidden
        className="absolute inset-0 opacity-30 mix-blend-overlay"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.06) 0 1px, transparent 1px 3px)",
        }}
      />
      <div aria-hidden className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3 sm:p-4">
        <span className="text-[10px] font-semibold tracking-[0.3em] text-white/60 uppercase">CineBook</span>
        <span className={`${textSize} leading-tight font-black tracking-tight text-balance text-white drop-shadow`}>
          {title}
        </span>
        {subtitle ? <span className="text-xs text-white/70">{subtitle}</span> : null}
      </div>
    </div>
  );
}
