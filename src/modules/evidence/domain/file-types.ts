/**
 * What a file may be, and whether it is what it says it is (PRD 14:
 * "file-type and malware scanning on upload").
 *
 * Two separate checks, and the distinction matters because they catch
 * different things.
 *
 * THE ALLOW-LIST answers "is this a kind of file PDDC accepts as evidence".
 * It is an allow-list rather than a block-list of dangerous extensions,
 * because a block-list is a list of the attacks somebody thought of. An
 * investigator uploading a `.scr` is not a case the platform needs to
 * support, so it does not need to be enumerated as forbidden: it is simply
 * not on the list.
 *
 * THE SIGNATURE CHECK answers "is this file actually that kind". A browser
 * reports whatever the operating system associates with the extension, and an
 * extension is a filename. So a Windows executable renamed `statement.pdf`
 * arrives declared as `application/pdf` and the allow-list waves it through.
 * The first bytes do not lie: `MZ` is a DOS header whatever the file is
 * called. This is the check that makes the allow-list mean anything.
 *
 * Both are pure, which is the point of them being here: the same rules apply
 * at upload, at verification and in a scheduled re-check, and a rule in three
 * places is three rules.
 */

/**
 * The types PDDC accepts, with the extensions each may legitimately carry.
 *
 * Chosen from what PRD 6 says evidence actually is: documents, photographs,
 * recordings, spreadsheets and their printed forms. Anything else is a
 * conversation with an administrator rather than a silent upload.
 */
export const PERMITTED_FILE_TYPES: Record<string, readonly string[]> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "image/tiff": [".tif", ".tiff"],
  "image/heic": [".heic"],
  "video/mp4": [".mp4", ".m4v"],
  "video/quicktime": [".mov"],
  "audio/mpeg": [".mp3"],
  "audio/mp4": [".m4a"],
  "audio/wav": [".wav"],
  "audio/x-wav": [".wav"],
  "text/plain": [".txt", ".log", ".csv"],
  "text/csv": [".csv"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-outlook": [".msg"],
  "message/rfc822": [".eml"],
  "application/zip": [".zip"],
};

export interface FileTypeVerdict {
  ok: boolean;
  /** For a refusal, a sentence an investigator can act on. */
  reason: string | null;
}

export function extensionOf(fileName: string): string {
  const at = fileName.lastIndexOf(".");
  return at === -1 ? "" : fileName.slice(at).toLowerCase();
}

/**
 * Whether a declared type and filename are acceptable and agree.
 *
 * Checked server-side at upload, where the only inputs are what the browser
 * said. It cannot detect a disguised file; that is what the signature check
 * below is for, and it runs later because it needs the bytes.
 */
export function checkDeclaredType(input: {
  fileName: string;
  fileType: string;
}): FileTypeVerdict {
  const declared = input.fileType.trim().toLowerCase().split(";")[0]!.trim();
  const extension = extensionOf(input.fileName);

  if (!declared) {
    return {
      ok: false,
      reason:
        "The browser did not say what kind of file this is. Rename it with its proper extension and upload it again.",
    };
  }

  const permitted = PERMITTED_FILE_TYPES[declared];

  if (!permitted) {
    return {
      ok: false,
      reason: `${declared} is not a kind of file this platform accepts as evidence. Documents, images, recordings and spreadsheets are; anything else needs an administrator to add it deliberately.`,
    };
  }

  if (!extension) {
    return {
      ok: false,
      reason:
        "That filename has no extension. Evidence is kept under its real name, and a name that does not say what the file is makes the register harder to read years later.",
    };
  }

  if (!permitted.includes(extension)) {
    return {
      ok: false,
      reason: `The file is named ${extension} but the browser reports it as ${declared}. One of the two is wrong, and uploading it either way would put a misleading record in the register.`,
    };
  }

  return { ok: true, reason: null };
}

/**
 * The first bytes of each format, for the check that cannot be fooled by a
 * filename.
 *
 * Only formats with an unambiguous magic number are listed. Plain text, CSV
 * and `.eml` have none: a text file starts with its text. Those are reported
 * as `unknown` rather than guessed at, and `unknown` is not a failure.
 * Claiming to recognise a format that cannot be recognised would be worse
 * than admitting the limit.
 */
const SIGNATURES: ReadonlyArray<{
  type: string;
  offset: number;
  bytes: readonly number[];
}> = [
  { type: "application/pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { type: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  {
    type: "image/png",
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { type: "image/gif", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  // RIFF....WEBP: the size sits between, so the second part is matched at 8.
  { type: "image/webp", offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  { type: "image/tiff", offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] }, // little endian
  { type: "image/tiff", offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] }, // big endian
  { type: "image/heic", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ftyp
  { type: "video/mp4", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  { type: "video/quicktime", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  { type: "audio/mp4", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  { type: "audio/mpeg", offset: 0, bytes: [0x49, 0x44, 0x33] }, // ID3
  { type: "audio/wav", offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] }, // WAVE
  // The Office formats and .zip are all zip containers, so they share a
  // signature and cannot be told apart by it. That is honest: a .docx IS a
  // zip, and the check here is "this is a zip", which is what it can know.
  { type: "application/zip", offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: "application/msword", offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { type: "application/vnd.ms-excel", offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  {
    type: "application/vnd.ms-outlook",
    offset: 0,
    bytes: [0xd0, 0xcf, 0x11, 0xe0],
  },
];

/**
 * The signatures of things no upload should ever carry.
 *
 * Listed NOT so they can be blocked by name: the allow-list already refuses
 * every one of them, because none is a permitted type. They are here so a
 * disguise can be RECOGNISED. Without them an executable renamed
 * `statement.pdf` sniffs as `unknown`, and `unknown` passes, because passing
 * the unrecognised is what lets a text file through. That is exactly the hole
 * the test for this found, and the lesson is that "refuse what you do not
 * know" and "refuse what you know is wrong" are different rules: the first
 * refuses a CSV, and only the second catches the file somebody disguised.
 *
 * A short list, and it does not need to be long. A format with no signature
 * here is still refused by the allow-list the moment it is declared
 * honestly; what this covers is the handful anybody would actually try to
 * smuggle in under another name.
 */
const EXECUTABLE_SIGNATURES: ReadonlyArray<{
  label: string;
  offset: number;
  bytes: readonly number[];
}> = [
  { label: "a Windows executable", offset: 0, bytes: [0x4d, 0x5a] }, // MZ
  { label: "a Linux executable", offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46] }, // ELF
  { label: "a macOS executable", offset: 0, bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { label: "a macOS executable", offset: 0, bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { label: "a Java class file", offset: 0, bytes: [0xca, 0xfe, 0xba, 0xbe] },
  // A script with a shebang. Text in every other respect, which is why the
  // first two bytes are the only thing that distinguishes it.
  { label: "a shell script", offset: 0, bytes: [0x23, 0x21] }, // #!
];

function executableLabel(head: Uint8Array): string | null {
  for (const signature of EXECUTABLE_SIGNATURES) {
    const end = signature.offset + signature.bytes.length;
    if (head.length < end) continue;

    let matched = true;
    for (let index = 0; index < signature.bytes.length; index += 1) {
      if (head[signature.offset + index] !== signature.bytes[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return signature.label;
  }
  return null;
}

/** The types that share a signature with another, grouped. */
const EQUIVALENT: ReadonlyArray<readonly string[]> = [
  // Zip containers.
  [
    "application/zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  // The old OLE compound formats.
  [
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-outlook",
  ],
  // ISO base media: mp4, mov, m4a and heic all begin `....ftyp`.
  ["video/mp4", "video/quicktime", "audio/mp4", "image/heic"],
];

/** Formats whose contents are their own signature. */
const UNSIGNED_TYPES = new Set([
  "text/plain",
  "text/csv",
  "message/rfc822",
  "audio/x-wav",
]);

/**
 * What the bytes say this file is.
 *
 * Needs only the first sixteen, so the caller can sniff a header without
 * reading a 50MB object into memory.
 */
export function sniffType(head: Uint8Array): string | "unknown" {
  for (const signature of SIGNATURES) {
    const end = signature.offset + signature.bytes.length;
    if (head.length < end) continue;

    let matched = true;
    for (let index = 0; index < signature.bytes.length; index += 1) {
      if (head[signature.offset + index] !== signature.bytes[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return signature.type;
  }
  return "unknown";
}

/**
 * Whether the bytes agree with what the file claimed to be.
 *
 * `unknown` passes, deliberately. A text file has no signature, and refusing
 * everything unrecognised would refuse the formats PDDC uses most. What this
 * catches is the case that matters: a file whose bytes say it is one thing
 * while its name and declared type say another, which no honest upload
 * produces.
 */
export function checkSignature(input: {
  declaredType: string;
  head: Uint8Array;
}): FileTypeVerdict {
  const declared = input.declaredType.trim().toLowerCase().split(";")[0]!.trim();

  // FIRST, and before the unsigned types are waved through. An executable is
  // refused whatever it claims to be, including `text/plain`: a shell script
  // genuinely IS text, and that is precisely why it would otherwise pass.
  const executable = executableLabel(input.head);
  if (executable) {
    return {
      ok: false,
      reason: `The stored file begins like ${executable}, however it was named or declared. Nothing executable is evidence, and a file that arrived disguised as one of PDDC's own formats is a finding in its own right rather than an upload to retry.`,
    };
  }

  if (UNSIGNED_TYPES.has(declared)) {
    return { ok: true, reason: null };
  }

  const actual = sniffType(input.head);

  if (actual === "unknown") {
    return { ok: true, reason: null };
  }
  if (actual === declared) {
    return { ok: true, reason: null };
  }

  const interchangeable = EQUIVALENT.some(
    (group) => group.includes(actual) && group.includes(declared),
  );
  if (interchangeable) return { ok: true, reason: null };

  return {
    ok: false,
    reason: `The stored file begins like ${actual}, not like the ${declared} it was uploaded as. A file that is not what it says it is cannot be relied on as evidence, whatever it turns out to contain.`,
  };
}

/**
 * How much of a file is needed to sniff it.
 *
 * Twelve would do for every signature above; sixteen is a round number with
 * room for one more.
 */
export const SIGNATURE_BYTES = 16;
