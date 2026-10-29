"use client";

import { useActionState } from "react";
import { Loader2, Upload } from "lucide-react";
import { Alert, Button, Card, Field, Id, Input } from "@/components/ui";
import { importUsersCsv } from "./bulk-import";
import { EMPTY_FORM_STATE } from "./schema";

/**
 * CSV bulk import (PRD 3.3).
 *
 * Its own form rather than the shared ActionForm, because a file input and a
 * multi-line error report need different handling: a rejected import lists
 * every problem it found, by line, and nothing is created until all of them
 * are fixed.
 */
export function CsvImport() {
  const [state, action, pending] = useActionState(importUsersCsv, EMPTY_FORM_STATE);

  return (
    <Card
      title="Bulk import from CSV"
      description="For provisioning several existing PDDC staff at once. The whole file is checked before anything is created."
    >
      <form action={action} className="space-y-4">
        {state.error && (
          <Alert tone="danger" title="Nothing was imported">
            {/* The report is line-oriented, so it is rendered as such. */}
            <pre className="font-id mt-1 max-h-56 overflow-auto text-[11px] whitespace-pre-wrap">
              {state.error}
            </pre>
          </Alert>
        )}
        {state.success && <Alert tone="ok">{state.success}</Alert>}

        <Field
          label="CSV file"
          htmlFor="csv-file"
          required
          hint="At most 500 rows per import."
        >
          <Input
            id="csv-file"
            name="file"
            type="file"
            accept=".csv,text/csv"
            required
            disabled={pending}
          />
        </Field>

        <div className="rounded-lg bg-surface-sunken p-3">
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase">
            Expected columns
          </p>
          <p className="font-id text-[11px] break-all text-body">
            email,clearance,employee_id,job_title,roles
          </p>
          <ul className="mt-2 space-y-1 text-[11px] text-muted">
            <li>
              <Id>email</Id> is required, and must already exist in the PDDC
              staff directory. Somebody new to PDDC is invited individually
              instead.
            </li>
            <li>
              <Id>clearance</Id> is one of PUBLIC, INTERNAL, CONFIDENTIAL,
              RESTRICTED or STRICTLY_RESTRICTED, and defaults to INTERNAL.
            </li>
            <li>
              <Id>roles</Id> is a semicolon-separated list of role keys, for
              example <Id>investigator;qa_reviewer</Id>. The Administrator role
              cannot be granted this way, because it needs a second
              administrator.
            </li>
            <li>
              Accounts are created <strong>invited</strong>, not active, so a
              mistake in the file grants nobody anything until you activate
              them.
            </li>
          </ul>
        </div>

        <Button type="submit" tone="secondary" disabled={pending}>
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Checking the file
            </>
          ) : (
            <>
              <Upload className="size-4" aria-hidden="true" />
              Validate and import
            </>
          )}
        </Button>
      </form>
    </Card>
  );
}
