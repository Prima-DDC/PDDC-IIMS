import { AppLink } from "@/components/AppLink";
import type { ComponentProps, ReactNode } from "react";

/**
 * Shared presentational primitives.
 *
 * Hand-rolled rather than pulled from a component library, matching the
 * convention already in prima-website-2.0. Everything here is a server
 * component unless it needs state, so the client bundle stays small on pages
 * that are mostly tables.
 */

/* ------------------------------------------------------------------ layout */

export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
}: {
  title: string;
  description?: string;
  breadcrumb?: Array<{ label: string; href?: string }>;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6">
      {breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {breadcrumb.map((crumb, i) => (
              <li key={`${crumb.label}-${i}`} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden="true" className="text-faint">/</span>}
                {crumb.href ? (
                  <AppLink href={crumb.href} className="hover:text-signal-dark hover:underline">
                    {crumb.label}
                  </AppLink>
                ) : (
                  <span className="text-body">{crumb.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-body sm:text-2xl">
            {title}
          </h1>
          {description && (
            <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card rounded-xl ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-semibold tracking-wide text-body">{title}</h2>
            )}
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ button */

type ButtonTone = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_TONES: Record<ButtonTone, string> = {
  primary:
    "bg-signal text-white hover:bg-signal-dark disabled:bg-signal/50 shadow-sm",
  secondary:
    "border border-line bg-surface text-body hover:bg-surface-sunken disabled:text-faint",
  ghost: "text-muted hover:bg-surface-sunken hover:text-body",
  danger:
    "border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20 disabled:opacity-50",
};

const BUTTON_SIZES = {
  sm: "h-8 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
} as const;

export function Button({
  tone = "secondary",
  size = "md",
  className = "",
  ...props
}: ComponentProps<"button"> & { tone?: ButtonTone; size?: keyof typeof BUTTON_SIZES }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-md font-medium transition-colors active:scale-[0.98] disabled:cursor-not-allowed ${BUTTON_TONES[tone]} ${BUTTON_SIZES[size]} ${className}`}
    />
  );
}

export function ButtonLink({
  tone = "secondary",
  size = "md",
  className = "",
  ...props
}: ComponentProps<typeof AppLink> & {
  tone?: ButtonTone;
  size?: keyof typeof BUTTON_SIZES;
}) {
  return (
    <AppLink
      {...props}
      className={`inline-flex items-center justify-center rounded-md font-medium transition-colors active:scale-[0.98] ${BUTTON_TONES[tone]} ${BUTTON_SIZES[size]} ${className}`}
    />
  );
}

/* ------------------------------------------------------------------- badges */

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "warn" | "danger" | "info" | "signal";
  children: ReactNode;
}) {
  const tones = {
    neutral: "border-line bg-surface-sunken text-muted",
    ok: "border-ok/35 bg-ok/10 text-ok",
    warn: "border-warn/35 bg-warn/10 text-warn",
    danger: "border-danger/40 bg-danger/10 text-danger",
    info: "border-info/35 bg-info/10 text-info",
    signal: "border-signal/35 bg-signal/10 text-signal-dark",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------- forms */

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-body">
        {label}
        {required && (
          <span className="ml-0.5 text-danger" aria-label="required">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && <p className="text-[11px] text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-[11px] font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL =
  "w-full rounded-md border border-line bg-surface px-2.5 py-2 text-sm text-body placeholder:text-faint focus:border-signal focus:outline-none focus:ring-2 focus:ring-signal/25 disabled:bg-surface-sunken disabled:text-faint";

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input {...props} className={`${CONTROL} ${className}`} />;
}

export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={`${CONTROL} ${className}`} />;
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return <select {...props} className={`${CONTROL} ${className}`} />;
}

/* ------------------------------------------------------------------- tables */

/**
 * A list of free-text rows posted as repeated fields of one name.
 *
 * Stateless on purpose: the owning form holds the array, so the same component
 * serves a case objective's questions and an investigation plan's sources
 * without either having to know about the other.
 */
export function ListField({
  label,
  name,
  values,
  onChange,
  placeholder,
  hint,
  error,
}: {
  label: string;
  name: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <p className="block text-xs font-medium text-body">{label}</p>
      <div className="space-y-2">
        {values.map((value, index) => (
          <div key={index} className="flex gap-2">
            <div className="flex-1">
              <label htmlFor={`${name}-${index}`} className="sr-only">
                {label} {index + 1}
              </label>
              <Input
                id={`${name}-${index}`}
                name={name}
                defaultValue={value}
                placeholder={index === 0 ? placeholder : undefined}
              />
            </div>
            {values.length > 1 && (
              <button
                type="button"
                onClick={() => onChange(values.filter((_, i) => i !== index))}
                aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                className="rounded-md px-2 text-xs text-muted hover:bg-surface-sunken hover:text-body"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...values, ""])}
        className="text-[11px] font-medium text-signal-dark hover:underline"
      >
        Add another
      </button>
      {hint && !error && <p className="text-[11px] text-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-[11px] font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- table */

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>
    </div>
  );
}

// Both pass the rest of their props through, so a cell that spans an inline
// editing row can say colSpan without a second component.
export function Th({ children, className = "", ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      {...props}
      className={`border-b border-line px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-muted uppercase ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = "", ...props }: ComponentProps<"td">) {
  return (
    <td
      {...props}
      className={`border-b border-line px-3 py-2.5 align-middle ${className}`}
    >
      {children}
    </td>
  );
}

/* --------------------------------------------------------------- empty, etc */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="text-sm font-medium text-body">{title}</p>
      {description && (
        <p className="mx-auto mt-1.5 max-w-md text-xs text-muted">{description}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "danger" | "ok";
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    info: "border-info/35 bg-info/10 text-info",
    warn: "border-warn/40 bg-warn/10 text-warn",
    danger: "border-danger/40 bg-danger/10 text-danger",
    ok: "border-ok/35 bg-ok/10 text-ok",
  };
  return (
    <div role="alert" className={`rounded-lg border p-3 text-xs ${tones[tone]}`}>
      {title && <p className="mb-0.5 text-sm font-semibold">{title}</p>}
      {children}
    </div>
  );
}

/** Key/value list, used on every detail page. */
export function DescriptionList({
  items,
}: {
  items: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
            {item.label}
          </dt>
          <dd className="mt-0.5 text-sm break-words text-body">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Monospaced identifier, used for case ids, hashes and employee numbers. */
export function Id({ children }: { children: ReactNode }) {
  return <span className="font-id text-[12.5px] text-body">{children}</span>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

/** Em-dash-free placeholder for an absent value. */
export function NotSet() {
  return <span className="text-faint">not set</span>;
}

/* --------------------------------------------------------------- paging */

/**
 * Page links for a list, driven by the same query string as its filters.
 *
 * `params` is the page's own search params, which are carried through so
 * paging does not drop the filters. `unit` names what is being counted,
 * because "25 clients" reads better than "25 results"; `plural` is for the
 * nouns that do not simply take an s, such as enquiry.
 */
export function Pagination({
  basePath,
  page,
  pageCount,
  total,
  params,
  unit = "record",
  plural,
}: {
  basePath: string;
  page: number;
  pageCount: number;
  total: number;
  params: Record<string, string | undefined>;
  unit?: string;
  plural?: string;
}) {
  const link = (target: number) => {
    const next = new URLSearchParams(
      Object.entries(params).filter(([, v]) => Boolean(v)) as [string, string][],
    );
    next.set("page", String(target));
    return `${basePath}?${next.toString()}`;
  };

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
      <p>
        {total} {total === 1 ? unit : (plural ?? `${unit}s`)}
        {pageCount > 1 ? `, page ${page} of ${pageCount}` : ""}
      </p>

      {pageCount > 1 && (
        <div className="flex gap-1.5">
          {page > 1 && (
            <ButtonLink href={link(page - 1)} size="sm">
              Previous
            </ButtonLink>
          )}
          {page < pageCount && (
            <ButtonLink href={link(page + 1)} size="sm">
              Next
            </ButtonLink>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ skeletons */

/*
 * Every skeleton carries `data-loading` and is hidden from assistive
 * technology.
 *
 * `aria-hidden` because a dozen empty grey boxes say nothing worth reading
 * out: the content they stand in for arrives on its own, and announcing the
 * placeholder would only interrupt.
 *
 * `data-loading` because something has to be able to tell "this panel has
 * not arrived yet" apart from "this panel arrived and offers you nothing".
 * Those look identical to a test, and conflating them is how a streamed panel
 * produced a failure fifty seconds later in a different step.
 */

/** Placeholder for a filter bar, while its reference data loads. */
export function FiltersSkeleton({ selects = 3 }: { selects?: number }) {
  return (
    <div className="flex gap-2" data-loading aria-hidden="true">
      <div className="skeleton h-9 flex-1" />
      {Array.from({ length: selects }, (_, i) => (
        <div key={i} className="skeleton h-9 w-36" />
      ))}
    </div>
  );
}

/**
 * Placeholder for a table.
 *
 * Each widget on a page gets its own Suspense boundary and its own skeleton,
 * so one slow query never blocks the rest of the page (PRD 11).
 */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="card space-y-2 rounded-xl p-5"
      data-loading
      aria-hidden="true"
    >
      <div className="skeleton h-4 w-full" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-10 w-full" />
      ))}
    </div>
  );
}

/**
 * A single number with a label, for the strip above a list.
 *
 * `tone` is used sparingly: a count that needs somebody's attention, such as
 * outstanding KYC, is worth colouring, and the rest are not.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  href,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "neutral" | "warn" | "danger" | "ok";
  href?: string;
}) {
  const tones = {
    neutral: "text-body",
    warn: "text-warn",
    danger: "text-danger",
    ok: "text-ok",
  };

  const body = (
    <>
      <p className="text-[10.5px] font-medium tracking-wide text-faint uppercase">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
    </>
  );

  if (href) {
    return (
      <AppLink
        href={href}
        className="card rounded-xl p-3.5 transition-colors hover:bg-surface-sunken"
      >
        {body}
      </AppLink>
    );
  }
  return <div className="card rounded-xl p-3.5">{body}</div>;
}
