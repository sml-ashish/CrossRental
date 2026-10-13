import { AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/cn";

export function Alert({
  tone = "error",
  title,
  children,
}: {
  tone?: "error" | "success" | "info";
  title?: string;
  children?: React.ReactNode;
}) {
  const styles = {
    error: "border-red-200 bg-red-50 text-red-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    info: "border-blue-200 bg-blue-50 text-blue-800",
  }[tone];

  const Icon = tone === "success" ? CheckCircle2 : AlertCircle;

  return (
    <div className={cn("flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm", styles)} role="alert">
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title && "mt-0.5")}>{children}</div> : null}
      </div>
    </div>
  );
}