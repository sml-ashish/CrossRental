import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  Compass,
  MapPin,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Ruler,
  Search,
  Sun,
  Timer,
  X,
} from "lucide-react";
import {
  TRAIL_LABELS,
  listRaisableLines,
  type EnquiryLineTrailStatus,
  type RaisableLine,
} from "@/lib/enquiries";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill";
import { cn } from "@/lib/cn";
import type { DiscoveryTheme } from "@/lib/discoveryTheme";

/**
 * Panel 1: the enquiry lines a crane can be found for.
 *
 * A line is a question already asked — it carries the crane type, tonnage, boom
 * lengths and the job site — so it is the natural place to start a search. The
 * panel is grouped by enquiry (a header per enquiry number) and the selected
 * line expands in place to show its requirement without leaving the list.
 *
 * The picker does not fetch recommendations: it only reports the chosen id to
 * the screen, which owns the URL and the map.
 */

export function useRaisableLines() {
  return useQuery({
    queryKey: ["enquiries", "raisable-lines"],
    queryFn: () => listRaisableLines(),
    staleTime: 60_000,
  });
}

/** `ENQ-2026-0001 / line 2` — the shared label for a line in this section. */
export function lineReference(line: RaisableLine): string {
  const number = line.enquiryNo.replace(/^CR-/, "");
  return `ENQ-${number} / line ${line.lineNo}`;
}

export function capacityText(line: Pick<RaisableLine, "capacityT" | "capacityRule">): string {
  if (line.capacityT === null) return "Capacity not set";
  return `${line.capacityRule === "EXACT" ? "=" : "≥"} ${line.capacityT} t`;
}

function durationText(line: Pick<RaisableLine, "durationValue" | "durationUnit">): string {
  if (line.durationValue === null || !line.durationUnit) return "Duration not set";
  const unit = line.durationUnit === "DAYS" ? "day" : "month";
  const plural = line.durationValue === 1 ? "" : "s";
  return `${line.durationValue} ${unit}${plural}`;
}

function shortDay(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

function startText(line: Pick<RaisableLine, "startDateTbc" | "requiredStartDate">): string {
  if (line.startDateTbc) return "Start TBC";
  return shortDay(line.requiredStartDate) ?? "No start date";
}

function hasPin(line: Pick<RaisableLine, "siteLatitude" | "siteLongitude">): boolean {
  return typeof line.siteLatitude === "number" && typeof line.siteLongitude === "number";
}

function trailTone(status: EnquiryLineTrailStatus): StatusPillTone {
  switch (status) {
    case "NEW":
      return "neutral";
    case "CLOSED":
      return "muted";
    case "CANCELLED":
      return "red";
    case "VENDOR_FINALISED":
    case "BOOKED":
    case "FULFILLED_INTERNALLY":
      return "emerald";
    case "RFQ_SENT":
    case "AWAITING_QUOTES":
    case "QUOTES_RECEIVED":
    case "UNDER_EVALUATION":
      return "amber";
    case "AVAILABILITY_CHECK":
    case "VENDOR_SHORTLISTED":
      return "blue";
  }
}

/** Sun/moon switch for the workspace theme. Shows the mode you would switch TO. */
export function ThemeToggle({
  theme,
  onToggle,
  className,
}: {
  theme: DiscoveryTheme;
  onToggle: () => void;
  className?: string;
}) {
  const toLight = theme === "dark";
  const Icon = toLight ? Sun : Moon;
  const label = toLight ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function lineMatches(line: RaisableLine, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    line.enquiryNo,
    line.craneTypeName,
    line.craneTypeCode,
    line.siteLocation,
    line.siteStateName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

type LineFilter = "all" | "rfq" | "no-rfq";

const LINE_FILTERS: Array<{ value: LineFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "rfq", label: "RFQ raised" },
  { value: "no-rfq", label: "No RFQ yet" },
];

export interface LinePanelProps {
  lineId: string | null;
  lines: RaisableLine[] | undefined;
  isPending: boolean;
  error: Error | null;
  greeting: string;
  displayName: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  theme: DiscoveryTheme;
  onToggleTheme: () => void;
  onPickLine: (lineId: string) => void;
  onClear: () => void;
  onRetry: () => void;
  /** Mobile: the sheet closes itself once a line is picked. */
  onPicked?: () => void;
}

export function LinePanel({
  lineId,
  lines,
  isPending,
  error,
  greeting,
  displayName,
  collapsed,
  onToggleCollapsed,
  theme,
  onToggleTheme,
  onPickLine,
  onClear,
  onRetry,
  onPicked,
}: LinePanelProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LineFilter>("all");
  const searchId = useId();

  const matches = useMemo(() => {
    const needle = query.trim();
    return (lines ?? []).filter((line) => {
      if (!lineMatches(line, needle)) return false;
      if (filter === "rfq") return line.rfqCount > 0;
      if (filter === "no-rfq") return line.rfqCount === 0;
      return true;
    });
  }, [lines, query, filter]);

  const groups = useMemo(() => {
    const byEnquiry = new Map<string, { enquiryNo: string; lines: RaisableLine[] }>();
    for (const line of matches) {
      const group = byEnquiry.get(line.enquiryId);
      if (group) group.lines.push(line);
      else byEnquiry.set(line.enquiryId, { enquiryNo: line.enquiryNo, lines: [line] });
    }
    return [...byEnquiry.values()];
  }, [matches]);

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-2 py-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Show enquiry lines"
          title="Show enquiry lines"
          className="flex size-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white"
        >
          <PanelLeftOpen className="size-4" aria-hidden />
        </button>
        <div className="my-1 h-px w-6 bg-ink-800" aria-hidden />
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Search enquiry lines"
          title="Search enquiry lines"
          className="flex size-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white"
        >
          <Search className="size-4" aria-hidden />
        </button>
        <span className="mt-1 text-[11px] font-semibold text-neutral-500 tabular-nums">
          {lines?.length ?? 0}
        </span>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} className="mt-auto" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-5 pt-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[12px] text-neutral-500">
              {greeting}, <span className="text-neutral-300">{displayName}</span>
            </p>
            <h1 className="mt-0.5 truncate text-[22px] leading-none font-semibold tracking-tight text-white">
              Find cranes
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Collapse enquiry lines"
              title="Collapse"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-ink-850 hover:text-white"
            >
              <PanelLeftClose className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        <div className="relative mt-4">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-neutral-500"
            aria-hidden
          />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Enquiry no., site or crane type"
            aria-label="Search enquiry lines"
            className="w-full rounded-lg border border-transparent bg-ink-850 py-2.5 pr-3 pl-9 text-[13px] text-neutral-100 placeholder:text-neutral-500 focus:border-ink-700 focus:outline-none"
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {LINE_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              aria-pressed={filter === option.value}
              className={cn(
                "rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
                filter === option.value
                  ? "bg-white text-ink-950"
                  : "border border-ink-700 text-neutral-400 hover:text-white",
              )}
            >
              {option.label}
            </button>
          ))}
          {lineId ? (
            <button
              type="button"
              onClick={onClear}
              className="ml-auto flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-neutral-400 transition-colors hover:bg-ink-850 hover:text-white"
            >
              <X className="size-3" aria-hidden />
              Browse all
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-5">
        {error ? (
          <div className="p-2">
            <Alert tone="error" title="Could not load enquiry lines">
              <p>{error.message}</p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 rounded-md border border-red-400/40 px-2 py-1 text-[12px] font-medium text-red-700 hover:bg-red-500/10"
              >
                Try again
              </button>
            </Alert>
          </div>
        ) : isPending ? (
          <div className="space-y-2 p-2" aria-hidden>
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<Compass className="size-4" aria-hidden />}
            title="No open lines match"
            description="Clear the search, or open the enquiry to add a line."
            className="px-2 py-10 [&_p]:text-neutral-200 [&_p:last-child]:text-neutral-500"
          />
        ) : (
          groups.map((group) => (
            <section key={group.enquiryNo} className="mb-4">
              <p className="px-2 pt-2 pb-1.5 text-[11px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
                {group.enquiryNo}
              </p>
              <ul className="space-y-1.5">
                {group.lines.map((line) => (
                  <li key={line.id}>
                    <LineRow
                      line={line}
                      selected={line.id === lineId}
                      onSelect={() => {
                        onPickLine(line.id);
                        onPicked?.();
                      }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function LineRow({
  line,
  selected,
  onSelect,
}: {
  line: RaisableLine;
  selected: boolean;
  onSelect: () => void;
}) {
  const place = `${line.siteLocation}${line.siteStateName ? `, ${line.siteStateName}` : ""}`;
  const rfqText =
    line.rfqCount > 0 ? `${line.rfqCount} RFQ${line.rfqCount === 1 ? "" : "s"}` : "No RFQ";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border transition-colors",
        selected
          ? "border-accent-500/60 bg-accent-500/10"
          : "border-transparent hover:border-ink-800 hover:bg-ink-850",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="w-full px-3.5 py-3 text-left"
      >
        <span className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "truncate text-[13px] font-semibold",
              selected ? "text-white" : "text-neutral-100",
            )}
          >
            {lineReference(line)}
          </span>
          <StatusPill tone={trailTone(line.trailStatus)} className="shrink-0 px-2 text-[11px]">
            {TRAIL_LABELS[line.trailStatus]}
          </StatusPill>
        </span>

        <span className="mt-1 block truncate text-[12px] text-neutral-400">
          {line.craneTypeName ?? line.craneTypeCode ?? "Crane type not set"} ·{" "}
          {capacityText(line)}
        </span>

        <span className="mt-1.5 flex items-center gap-1.5 text-[12px] text-neutral-500">
          <MapPin className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{place}</span>
        </span>

        <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-neutral-500">
          <CalendarDays className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {startText(line)} · {rfqText}
          </span>
        </span>
      </button>

      {selected ? (
        <div className="border-t border-accent-500/25 px-3.5 py-3">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-neutral-500 uppercase">
            Requirement
          </p>
          <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-3 text-[12px]">
            <Fact icon={Ruler} label="Crane" value={line.craneTypeName ?? "Not set"} />
            <Fact icon={Ruler} label="Capacity" value={capacityText(line)} />
            <Fact icon={CalendarDays} label="Start" value={startText(line)} />
            <Fact icon={Timer} label="Duration" value={durationText(line)} />
            <div className="col-span-2 flex min-w-0 items-start gap-1.5">
              <MapPin className="mt-0.5 size-3.5 shrink-0 text-neutral-500" aria-hidden />
              <dd className="min-w-0">
                <span className="block truncate text-neutral-300">{place}</span>
                <span
                  className={cn(
                    "mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0 text-[11px] font-medium",
                    hasPin(line)
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-amber-200 bg-amber-50 text-amber-700",
                  )}
                >
                  {hasPin(line) ? "Pinned" : "Location unverified"}
                </span>
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[11px] tracking-[0.06em] text-neutral-500 uppercase">
        <Icon className="size-2.5" aria-hidden />
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-neutral-300">{value}</dd>
    </div>
  );
}
