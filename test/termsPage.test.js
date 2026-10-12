const { renderTermsPage, contactLink } = require("../src/termsPage");

describe("contactLink", () => {
  test("an email address becomes a mailto: link, anything else a plain link, both escaped", () => {
    expect(contactLink("rights@example.com")).toBe('<a href="mailto:rights@example.com">rights@example.com</a>');
    expect(contactLink("https://example.com/report?a=1&b=2")).toBe(
      '<a href="https://example.com/report?a=1&amp;b=2">https://example.com/report?a=1&amp;b=2</a>'
    );
  });
});

describe("renderTermsPage", () => {
  const page = renderTermsPage({
    contact: "rights@example.com",
    credits: [
      { text: "With a logo", href: "https://a.example", image: "/a.svg", imageAlt: "A" },
      { text: "With a logo and no alt text", href: "https://b.example", image: "/b.svg" },
      { text: "Text <only>", href: "https://c.example" }
    ]
  });

  test("the contact is where questions and removal requests go", () => {
    expect(page.match(/mailto:rights@example\.com/g)).toHaveLength(2);
  });

  test("credits, with their logos, escaped", () => {
    expect(page).toContain('<li><img src="/a.svg" alt="A" height="12" /> <a href="https://a.example"');
    expect(page).toContain('<li><img src="/b.svg" alt="" height="12" /> <a href="https://b.example"');
    expect(page).toContain(">Text &lt;only&gt;</a></li>");
  });

  test("YouTube's copyright process for removal from YouTube itself", () => {
    expect(page).toContain('href="https://support.google.com/youtube/answer/2807622"');
  });
});
