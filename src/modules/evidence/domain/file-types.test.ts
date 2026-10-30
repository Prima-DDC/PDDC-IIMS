import { describe, expect, it } from "vitest";
import {
  PERMITTED_FILE_TYPES,
  SIGNATURE_BYTES,
  checkDeclaredType,
  checkSignature,
  extensionOf,
  sniffType,
} from "./file-types";

/**
 * File-type checks (PRD 14).
 *
 * The case worth the most attention is the disguised executable, because it
 * is the one an allow-list alone lets through and the one somebody would
 * actually try.
 */

function bytes(...values: number[]): Uint8Array {
  const out = new Uint8Array(SIGNATURE_BYTES);
  out.set(values.slice(0, SIGNATURE_BYTES));
  return out;
}

const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04);
const EXE = bytes(0x4d, 0x5a, 0x90, 0x00); // MZ, a DOS header
const TEXT = bytes(0x54, 0x68, 0x65, 0x20); // "The "

describe("what a file may be", () => {
  it("accepts the kinds of file evidence actually is", () => {
    for (const [type, extensions] of Object.entries(PERMITTED_FILE_TYPES)) {
      const verdict = checkDeclaredType({
        fileName: `statement${extensions[0]}`,
        fileType: type,
      });
      expect(verdict.ok, `${type} ${extensions[0]}`).toBe(true);
    }
  });

  it("refuses a type nobody allow-listed", () => {
    // Not because `.exe` is enumerated as dangerous: because it is not on the
    // list. A block-list is a list of the attacks somebody thought of.
    const verdict = checkDeclaredType({
      fileName: "tool.exe",
      fileType: "application/x-msdownload",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/not a kind of file this platform accepts/i);
  });

  it("refuses a name and a type that disagree", () => {
    const verdict = checkDeclaredType({
      fileName: "statement.pdf",
      fileType: "image/png",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/One of the two is wrong/i);
  });

  it("refuses a file with no extension at all", () => {
    const verdict = checkDeclaredType({
      fileName: "statement",
      fileType: "application/pdf",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/no extension/i);
  });

  it("refuses a file the browser could not identify", () => {
    const verdict = checkDeclaredType({
      fileName: "statement.pdf",
      fileType: "",
    });
    expect(verdict.ok).toBe(false);
  });

  it("ignores a charset parameter and the case of the extension", () => {
    expect(
      checkDeclaredType({
        fileName: "notes.TXT",
        fileType: "text/plain; charset=utf-8",
      }).ok,
    ).toBe(true);
  });

  it("accepts both spellings of a jpeg", () => {
    expect(
      checkDeclaredType({ fileName: "a.jpg", fileType: "image/jpeg" }).ok,
    ).toBe(true);
    expect(
      checkDeclaredType({ fileName: "a.jpeg", fileType: "image/jpeg" }).ok,
    ).toBe(true);
  });

  it("reads an extension the way a filename with dots in it requires", () => {
    expect(extensionOf("statement.final.v2.pdf")).toBe(".pdf");
    expect(extensionOf("statement")).toBe("");
  });
});

describe("whether a file is what it says it is", () => {
  it("recognises the formats that have a signature", () => {
    expect(sniffType(PDF)).toBe("application/pdf");
    expect(sniffType(PNG)).toBe("image/png");
    expect(sniffType(JPEG)).toBe("image/jpeg");
    expect(sniffType(ZIP)).toBe("application/zip");
  });

  it("admits it cannot recognise plain text", () => {
    // Honest rather than guessing. A text file starts with its text, and
    // claiming to recognise it would be inventing a capability.
    expect(sniffType(TEXT)).toBe("unknown");
  });

  it("passes a file whose bytes match what it claimed", () => {
    expect(
      checkSignature({ declaredType: "application/pdf", head: PDF }).ok,
    ).toBe(true);
  });

  it("CATCHES AN EXECUTABLE RENAMED AS A PDF", () => {
    // The case this whole file exists for. The allow-list waves it through,
    // because `application/pdf` is permitted and `.pdf` agrees with it: the
    // browser reports what the extension implies, and the extension is just
    // part of the name. The bytes are the only thing that knows.
    const verdict = checkSignature({ declaredType: "application/pdf", head: EXE });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/Windows executable/i);
  });

  it("refuses an executable however it is declared, including as text", () => {
    // A shell script IS text, so the unsigned-type pass would have let it
    // through. The executable check therefore runs before that pass rather
    // than after it.
    const script = bytes(0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68);
    expect(
      checkSignature({ declaredType: "text/plain", head: script }).ok,
    ).toBe(false);
    expect(
      checkSignature({ declaredType: "application/pdf", head: bytes(0x7f, 0x45, 0x4c, 0x46) }).ok,
    ).toBe(false);
  });

  it("catches a png claiming to be a pdf", () => {
    expect(
      checkSignature({ declaredType: "application/pdf", head: PNG }).ok,
    ).toBe(false);
  });

  it("passes a text file, which has no signature to check", () => {
    expect(checkSignature({ declaredType: "text/plain", head: TEXT }).ok).toBe(
      true,
    );
    expect(checkSignature({ declaredType: "text/csv", head: TEXT }).ok).toBe(
      true,
    );
  });

  it("passes a docx, which genuinely is a zip", () => {
    // A .docx that sniffs as application/zip is correct, not suspicious: the
    // format is a zip container. Refusing it would refuse every Word file.
    expect(
      checkSignature({
        declaredType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        head: ZIP,
      }).ok,
    ).toBe(true);
  });

  it("passes an mp4 and a mov, which share a header", () => {
    const iso = bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70);
    expect(checkSignature({ declaredType: "video/mp4", head: iso }).ok).toBe(true);
    expect(
      checkSignature({ declaredType: "video/quicktime", head: iso }).ok,
    ).toBe(true);
  });

  it("passes a header too short to judge rather than refusing it", () => {
    // A zero-byte or truncated object is a different finding, recorded by the
    // integrity check as unreadable. It is not a disguised file.
    expect(
      checkSignature({
        declaredType: "application/pdf",
        head: new Uint8Array([0x25]),
      }).ok,
    ).toBe(true);
  });
});
