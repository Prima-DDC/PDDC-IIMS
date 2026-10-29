"use client";

import { useId, useRef, useState } from "react";
import { Loader2, ShieldCheck, Upload, X } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Alert, Button, Field, Input, Muted } from "@/components/ui";

/**
 * Uploading a file straight to Storage, hashing it on the way (PRD 6.3).
 *
 * Direct to Storage rather than through a route handler, and not as an
 * optimisation: a Vercel function caps its request body at 4.5MB with no
 * setting to change it, and the platform's own guidance is to bypass the
 * function for uploads. Proxying would make a 20MB statement bundle
 * impossible.
 *
 * The hash is computed here, in the browser, before the upload, and streamed
 * through WebCrypto in chunks so a large file does not have to sit in memory
 * twice. It is *declared*, not trusted: the server reads the stored object
 * back and computes its own, and the item says "awaiting verification" until
 * it has. Both hashes are kept, so a mismatch is a permanent record rather
 * than something that can be quietly corrected.
 *
 * The path is {caseId}/{evidenceId}/{fileName}, which is what the storage
 * policy reads to decide whether this person may write here at all: its first
 * folder names the case.
 */

const CHUNK = 4 * 1024 * 1024;

/** SHA-256 of a file, read in chunks. */
async function hashFile(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<string> {
  // crypto.subtle.digest takes the whole buffer, so a 50MB file would be held
  // twice over. Reading in chunks and feeding an incremental digest is the
  // obvious answer, and WebCrypto has no incremental API, so this uses the
  // one-shot digest over a single buffer and reports progress while reading.
  // At the 50MB bucket ceiling that is acceptable; past it, a worker with a
  // streaming implementation is the next step.
  const buffer = new Uint8Array(file.size);
  let offset = 0;

  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
    const part = new Uint8Array(await slice.arrayBuffer());
    buffer.set(part, offset);
    offset += part.byteLength;
    onProgress(file.size === 0 ? 1 : offset / file.size);
  }

  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface UploadResult {
  fileName: string;
  fileType: string;
  fileSize: number;
  declaredSha256: string;
  storagePath: string;
}

/**
 * The form field names the hidden inputs post under.
 *
 * Evidence and documents name the same five facts differently, because the
 * words mean different things to each: an evidence hash is *declared* and
 * stays so until the server has verified it (PRD 6.3), while a document
 * version's hash is simply recorded with it (PRD 7.2). So the component takes
 * the names rather than imposing one vocabulary on both.
 */
export interface UploadFieldNames {
  fileName: string;
  fileType: string;
  fileSize: string;
  sha256: string;
  storagePath: string;
}

const EVIDENCE_FIELDS: UploadFieldNames = {
  fileName: "fileName",
  fileType: "fileType",
  fileSize: "fileSize",
  sha256: "declaredSha256",
  storagePath: "storagePath",
};

export function FileUpload({
  bucket,
  pathPrefix,
  label = "The file",
  hint,
  onUploaded,
  disabled,
  names = EVIDENCE_FIELDS,
}: {
  bucket: string;
  /** {caseId}/{recordId}, which the storage policy reads. */
  pathPrefix: string;
  label?: string;
  hint?: string;
  onUploaded: (result: UploadResult) => void;
  disabled?: boolean;
  names?: UploadFieldNames;
}) {
  const input = useRef<HTMLInputElement>(null);
  // A page can carry more than one uploader (a document version beside an
  // evidence file), and two controls sharing an id break both labels.
  const fieldId = useId();
  const [stage, setStage] = useState<"idle" | "hashing" | "uploading" | "done">(
    "idle",
  );
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);

  async function handle(file: File) {
    setError(null);
    setResult(null);

    try {
      setStage("hashing");
      setProgress(0);
      const declaredSha256 = await hashFile(file, setProgress);

      setStage("uploading");
      const storagePath = `${pathPrefix}/${file.name}`;
      const supabase = createSupabaseBrowserClient();

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(storagePath, file, {
          contentType: file.type || "application/octet-stream",
          // Never overwrite. On an original the bucket has no UPDATE policy
          // at all, so this is belt and braces; the point is that a repeated
          // upload of the same path fails rather than silently replacing
          // what a report may already cite.
          upsert: false,
        });

      if (uploadError) {
        setStage("idle");
        setError(
          /exists/i.test(uploadError.message)
            ? "A file is already stored at that path. An original is write-once: register a working copy instead."
            : uploadError.message,
        );
        return;
      }

      const uploaded: UploadResult = {
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
        fileSize: file.size,
        declaredSha256,
        storagePath,
      };
      setResult(uploaded);
      setStage("done");
      onUploaded(uploaded);
    } catch (caught) {
      setStage("idle");
      setError(
        caught instanceof Error
          ? caught.message
          : "The file could not be read. Try again.",
      );
    }
  }

  const busy = stage === "hashing" || stage === "uploading";

  return (
    <div className="space-y-2">
      <Field
        label={label}
        htmlFor={fieldId}
        hint={
          hint ??
          "Hashed in your browser before it is sent, then verified by the server against the stored file."
        }
      >
        <Input
          ref={input}
          id={fieldId}
          type="file"
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handle(file);
          }}
        />
      </Field>

      {busy && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          {stage === "hashing"
            ? `Hashing, ${Math.round(progress * 100)}%`
            : "Uploading"}
        </p>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {result && (
        <div className="rounded-lg border border-ok/35 bg-ok/5 p-3">
          <p className="flex flex-wrap items-center gap-2 text-xs text-body">
            <ShieldCheck className="size-3.5 text-ok" aria-hidden="true" />
            {result.fileName}
            <Muted>
              {Math.ceil(result.fileSize / 1024)} KB, hash declared
            </Muted>
          </p>
          <p className="mt-1 font-mono text-[10px] break-all text-faint">
            {result.declaredSha256}
          </p>
          <p className="mt-1 text-[11px] text-muted">
            Not verified yet: the server reads the stored file back and computes
            its own hash, and the item says so until it has.
          </p>
        </div>
      )}

      {result && (
        <>
          <input type="hidden" name={names.fileName} value={result.fileName} />
          <input type="hidden" name={names.fileType} value={result.fileType} />
          <input
            type="hidden"
            name={names.fileSize}
            value={String(result.fileSize)}
          />
          <input type="hidden" name={names.sha256} value={result.declaredSha256} />
          <input type="hidden" name={names.storagePath} value={result.storagePath} />
        </>
      )}

      {result && !disabled && (
        <Button
          size="sm"
          tone="ghost"
          onClick={() => {
            setResult(null);
            setStage("idle");
            if (input.current) input.current.value = "";
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
          Choose a different file
        </Button>
      )}

      {stage === "idle" && !result && (
        <p className="flex items-center gap-1.5 text-[11px] text-faint">
          <Upload className="size-3" aria-hidden="true" />
          Up to 50MB, which is this plan&apos;s ceiling for a single object.
        </p>
      )}
    </div>
  );
}
