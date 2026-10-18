import { describe, expect, it } from "vitest";
import { interpretShare } from "./share";

describe("interpretShare", () => {
  it("takes the address when the app gives one", () => {
    expect(interpretShare({ title: "A page", url: "https://news.example/post" }, 0)).toEqual({ kind: "link", link: "https://news.example/post" });
  });

  it("finds an address that is all the text holds", () => {
    expect(interpretShare({ text: "  https://news.example/post  " }, 0)).toEqual({ kind: "link", link: "https://news.example/post" });
  });

  it("finds the address in a short note or after a title, as some Android apps share it", () => {
    expect(interpretShare({ text: "Great read https://news.example/post" }, 0)).toEqual({ kind: "link", link: "https://news.example/post" });
    expect(interpretShare({ title: "Page", text: "Page title\nhttps://news.example/post?a=1." }, 0)).toEqual({
      kind: "link",
      link: "https://news.example/post?a=1",
    });
  });

  it("keeps a long text that only mentions an address as a text", () => {
    const long = "A paragraph about something. ".repeat(20) + "More at https://news.example/post for details.";
    expect(interpretShare({ text: long }, 0)).toEqual({ kind: "text", text: long });
  });

  it("makes a text of the title and the text, once", () => {
    expect(interpretShare({ title: "Notes", text: "Cells are small." }, 0)).toEqual({ kind: "text", text: "Notes\n\nCells are small." });
    expect(interpretShare({ title: "Same", text: "Same" }, 0)).toEqual({ kind: "text", text: "Same" });
    expect(interpretShare({ title: "Only a title" }, 0)).toEqual({ kind: "text", text: "Only a title" });
  });

  it("says files when files came, whatever else came with them", () => {
    expect(interpretShare({ title: "lecture.pdf", text: "https://news.example/post" }, 1)).toEqual({ kind: "files" });
  });

  it("is empty when nothing readable came", () => {
    expect(interpretShare({}, 0)).toEqual({ kind: "empty" });
    expect(interpretShare({ title: "  ", text: "\n", url: "not an address" }, 0)).toEqual({ kind: "empty" });
  });

  it("does not take an address with a scheme other than http or https", () => {
    expect(interpretShare({ url: "javascript:alert(1)" }, 0)).toEqual({ kind: "empty" });
    expect(interpretShare({ text: "file:///etc/passwd" }, 0)).toEqual({ kind: "text", text: "file:///etc/passwd" });
  });
});
