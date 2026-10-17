/**
 * What AIOStreams would misread in a reader's templates, as advice for the
 * configure page. Only the text typed into a template is looked at: values
 * are guarded when they go in (streamFormat.js: guardName, plainText), but
 * text the reader wrote is theirs to keep.
 *
 * This file is the function and nothing else: the configure page runs it
 * from its source text, as it does formatter.js.
 */
function templateWarnings(nameTemplate, descriptionTemplate) {
  const CODES = ["RD", "AD", "PM", "DL", "TB", "TRB", "SN", "ND", "AIO", "NZB", "AM", "OC", "PO", "EN", "ED", "DBD", "DR",
    "DER", "DB", "PP", "PKP", "SR", "SDR", "ST", "TR", "TI", "TRN", "TorBox", "Premiumize", "Easynews", "Offcloud",
    "PikPak", "Seedr", "Torrin", "Debrider", "EasyDebrid", "RealDebrid", "AllDebrid", "DebridLink"];
  // The typed text alone: every {...} and {?...?} taken out, innermost first.
  const typed = (template) => {
    let text = String(template || "");
    for (let previous = ""; previous !== text; ) {
      previous = text;
      text = text.replace(/\{[^{}]*\}/g, " ");
    }
    return text.replace(/\?\}/g, " ");
  };
  const warnings = [];
  const name = typed(nameTemplate).replace(/web-?dl/gi, " ");
  const words = name.split(/[^A-Za-z0-9]+/).filter((w) => CODES.some((c) => c.toLowerCase() === w.toLowerCase()));
  if (words.length) {
    warnings.push(
      `AIOStreams reads “${words[0]}” in a stream's name as a debrid service, and would take these YouTube rows for debrid streams.`
    );
  }
  const description = typed(descriptionTemplate);
  if (/[👤👥]/u.test(description)) {
    warnings.push("AIOStreams reads a number after 👤 or 👥 in the description as torrent seeders.");
  }
  if (/\d\s?(KB|MB|GB|TB)(?![A-Za-z])/i.test(description)) {
    warnings.push("AIOStreams reads a size such as “1.5 GB” in the description as the file's size.");
  }
  if (/[\u{1F1E6}-\u{1F1FF}]{2}/u.test(description)) {
    warnings.push("AIOStreams reads a flag in the description as a language every stream is in.");
  }
  return warnings;
}

module.exports = { templateWarnings };
