import { describe, expect, it } from "vitest";
import { parseCsv, toRecord } from "./csv";

/**
 * The CSV reader for the bulk user import.
 *
 * Tested exhaustively because this path grants access to case material: a
 * misread column could give somebody the wrong clearance or the wrong role.
 */

describe("parseCsv", () => {
  it("reads a plain file", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles CRLF line endings, as a Windows spreadsheet produces", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps a comma inside a quoted field", () => {
    expect(parseCsv('name,title\n"Mensah, John",Investigator')).toEqual([
      ["name", "title"],
      ["Mensah, John", "Investigator"],
    ]);
  });

  it("keeps a newline inside a quoted field", () => {
    expect(parseCsv('note\n"line one\nline two"')).toEqual([
      ["note"],
      ["line one\nline two"],
    ]);
  });

  it("unescapes a doubled quote", () => {
    expect(parseCsv('title\n"the ""acting"" supervisor"')).toEqual([
      ["title"],
      ['the "acting" supervisor'],
    ]);
  });

  it("preserves empty fields in the middle of a row", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("drops a trailing newline rather than inventing a row", () => {
    expect(parseCsv("a\n1\n")).toHaveLength(2);
  });

  it("drops blank lines in the middle of a file", () => {
    expect(parseCsv("a\n1\n\n2\n")).toEqual([["a"], ["1"], ["2"]]);
  });

  it("drops a row of only commas", () => {
    expect(parseCsv("a,b\n1,2\n,")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\n")).toEqual([]);
  });

  it("reads a single row with no trailing newline", () => {
    expect(parseCsv("a,b")).toEqual([["a", "b"]]);
  });

  it("does not treat a quote inside an unquoted field as a quote", () => {
    // A field that starts unquoted is taken literally up to the next comma.
    expect(parseCsv('a\n5" pipe')).toEqual([["a"], ['5 pipe']]);
  });
});

describe("toRecord", () => {
  it("lower-cases and trims the header keys", () => {
    expect(toRecord([" Email ", "Clearance"], ["a@b.c", "INTERNAL"])).toEqual({
      email: "a@b.c",
      clearance: "INTERNAL",
    });
  });

  it("fills a missing trailing cell with an empty string", () => {
    expect(toRecord(["email", "roles"], ["a@b.c"])).toEqual({
      email: "a@b.c",
      roles: "",
    });
  });

  it("ignores extra cells beyond the header", () => {
    expect(toRecord(["email"], ["a@b.c", "ignored"])).toEqual({
      email: "a@b.c",
    });
  });
});
