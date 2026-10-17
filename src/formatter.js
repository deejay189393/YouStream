/**
 * Stream names and descriptions from templates, in the syntax of
 * AIOStreams' custom formatter: the language PenguPlay and others use too,
 * so a template means the same thing in each of them.
 *
 *   {stream.title}                      a field: section.property
 *   {stream.title::upper::truncate(20)} modifiers, applied left to right
 *   {video.official::istrue["✓"||""]}   a check picks a branch
 *   {a::exists::and::b::>5["x"||"y"]}   checks join with and, or, xor
 *   {? 📅 {video.uploaded} ?}           shown only when every field in it has
 *                                       a value
 *   {tools.newLine} {tools.removeLine}  layout
 *
 * Its behaviour follows AIOStreams' documentation (Custom Formatter
 * reference): what a missing value renders, how lists print, which checks
 * compare without case, the inline errors such as
 * `{unknown_propertyName(stream.foo)}`, and the blank lines dropped at the
 * end. The object-list modifiers (`::where`, `::pluck`, `::each`) have
 * nothing to work on here, so they are not implemented.
 *
 * `createFormatter` refers to nothing outside itself on purpose: the
 * configure page runs this very function, from its source text, so its
 * preview is the real thing.
 */
function createFormatter(options) {
  const opts = options || {};
  const languages = opts.languages || [];
  const MAX_DEPTH = 5;
  const MAX_LENGTH = 8000;
  const NEW_LINE = "\u0011";
  const REMOVE_LINE = "\u0012";
  const JOINERS = ["and", "or", "xor", "neq", "equal", "left", "right"];
  const PREFIXES = [">=", "<=", ">", "<", "=", "~", "$", "^"];
  const SMALL_CAPS = {
    A: "ᴀ", B: "ʙ", C: "ᴄ", D: "ᴅ", E: "ᴇ", F: "ғ", G: "ɢ", H: "ʜ", I: "ɪ", J: "ᴊ", K: "ᴋ", L: "ʟ", M: "ᴍ",
    N: "ɴ", O: "ᴏ", P: "ᴘ", Q: "ǫ", R: "ʀ", S: "ꜱ", T: "ᴛ", U: "ᴜ", V: "ᴠ", W: "ᴡ", X: "x", Y: "ʏ", Z: "ᴢ"
  };
  const DIGITS = "0123456789+-=()";
  const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎";
  const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
    "November", "December"];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // ------------------------------------------------------------------ values

  function isPresent(value) {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return /\S/.test(value);
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  function typeName(value) {
    return Array.isArray(value) ? "array" : typeof value;
  }

  /** Stream data can never forge a layout directive. */
  function scrub(text) {
    return text.split(NEW_LINE).join("").split(REMOVE_LINE).join("");
  }

  function capped(text) {
    return text.length > MAX_LENGTH ? text.slice(0, MAX_LENGTH) : text;
  }

  function mapChars(value, from, to) {
    const source = Array.from(from);
    const target = Array.from(to);
    const table = {};
    for (let i = 0; i < source.length && i < target.length; i++) table[source[i]] = target[i];
    return Array.from(value)
      .map((ch) => (Object.prototype.hasOwnProperty.call(table, ch) ? table[ch] : ch))
      .join("");
  }

  function findLanguage(value) {
    const lower = String(value).toLowerCase();
    for (let i = 0; i < languages.length; i++) {
      const l = languages[i];
      if (l.name.toLowerCase() === lower || l.code.toLowerCase() === lower) return l;
    }
    return null;
  }

  const languageCode = (value) => {
    const found = findLanguage(value);
    return found ? found.code.toUpperCase() : String(value).toUpperCase();
  };
  const languageEmoji = (value) => {
    const found = findLanguage(value);
    return (found && found.flag) || "";
  };
  const mapLanguages = (list, convert) => {
    const out = [];
    list.forEach((item) => {
      const converted = convert(String(item));
      if (converted && out.indexOf(converted) === -1) out.push(converted);
    });
    return out;
  };

  function base64(text) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bytes = [];
    Array.from(text).forEach((ch) => {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    });
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
      out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : "=";
      out += i + 2 < bytes.length ? alphabet[n & 63] : "=";
    }
    return out;
  }

  function formatBytes(bytes, k, mode) {
    if (bytes === 0) return "0 B";
    const sizes = k === 1024 ? ["B", "KiB", "MiB", "GiB", "TiB"] : ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(k))));
    const raw = bytes / Math.pow(k, i);
    if (mode === "smart") return smartNumber(raw) + " " + sizes[i];
    const value = parseFloat(raw.toFixed(2));
    return (mode === "round" ? Math.round(value) : value) + " " + sizes[i];
  }

  function smartNumber(raw) {
    const whole = Math.floor(raw);
    if (whole >= 100) return String(Math.round(raw));
    if (whole >= 10) {
      const value = parseFloat(raw.toFixed(1));
      return value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
    }
    return String(parseFloat(raw.toFixed(2)));
  }

  function formatBitrate(bitrate, mode) {
    if (!(bitrate > 0) || !isFinite(bitrate)) return "0 bps";
    const sizes = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
    const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bitrate) / Math.log(1000))));
    const raw = bitrate / Math.pow(1000, i);
    if (mode === "smart") return smartNumber(raw) + " " + sizes[i];
    return (mode === "round" ? Math.round(raw) : parseFloat(raw.toFixed(2))) + " " + sizes[i];
  }

  /** Minutes below 1000 (a runtime) and milliseconds above it (a duration). */
  function toMs(value) {
    if (value < 0) return 0;
    return value < 1000 ? value * 60000 : value;
  }

  function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return hours + "h:" + (minutes % 60) + "m:" + (seconds % 60) + "s";
    if (seconds % 60 > 0) return (minutes % 60) + "m:" + (seconds % 60) + "s";
    return (minutes % 60) + "m";
  }

  /**
   * A %-token pattern. `[...]` is dropped when every token in it came out
   * zero; `%%`, `%[` and `%]` are literals; an unknown token stays as typed.
   */
  function renderPattern(pattern, resolve) {
    const stack = [{ text: "", zero: true, saw: false }];
    const close = () => {
      const group = stack.pop();
      const parent = stack[stack.length - 1];
      if (!group.saw || !group.zero) {
        parent.text += group.text;
        parent.saw = parent.saw || group.saw;
        if (!group.zero) parent.zero = false;
      }
    };
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      const top = stack[stack.length - 1];
      if (ch === "%") {
        const next = pattern[i + 1];
        if (next === undefined) {
          top.text += "%";
          break;
        }
        if (next === "%" || next === "[" || next === "]") {
          top.text += next;
          i += 1;
          continue;
        }
        const token = next === "-" ? pattern.slice(i + 1, i + 3) : next;
        const resolved = resolve(token);
        if (resolved === undefined) top.text += "%" + token;
        else {
          top.text += resolved.text;
          top.saw = true;
          if (!resolved.zero) top.zero = false;
        }
        i += token.length;
      } else if (ch === "[") {
        stack.push({ text: "", zero: true, saw: false });
      } else if (ch === "]" && stack.length > 1) {
        close();
      } else {
        top.text += ch;
      }
    }
    while (stack.length > 1) close();
    return stack[0].text;
  }

  function durationPattern(ms, pattern) {
    const units = {};
    renderPattern(pattern, (token) => {
      const unit = token.charAt(0) === "-" ? token.slice(1) : token;
      if (unit !== "H" && unit !== "M" && unit !== "S") return undefined;
      units[unit] = true;
      return { text: "" };
    });
    const total = Math.max(0, Math.floor(ms / 1000));
    const values = {
      H: Math.floor(total / 3600),
      M: units.H ? Math.floor(total / 60) % 60 : Math.floor(total / 60),
      S: units.H || units.M ? total % 60 : total
    };
    return renderPattern(pattern, (token) => {
      const padded = token.charAt(0) !== "-";
      const value = values[padded ? token : token.slice(1)];
      if (value === undefined) return undefined;
      return { text: padded ? String(value).padStart(2, "0") : String(value), zero: value === 0 };
    });
  }

  function ordinal(day) {
    const teens = day % 100;
    if (teens >= 11 && teens <= 13) return day + "th";
    return day + (["th", "st", "nd", "rd"][day % 10] || "th");
  }

  function datePattern(value, pattern) {
    const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim());
    if (!parts) return value;
    const year = Number(parts[1]);
    const month = Number(parts[2]) - 1;
    const day = Number(parts[3]);
    const date = new Date(Date.UTC(year, month, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return value;
    const tokens = {
      Y: String(year),
      y: String(year % 100).padStart(2, "0"),
      m: String(month + 1).padStart(2, "0"),
      "-m": String(month + 1),
      d: String(day).padStart(2, "0"),
      "-d": String(day),
      o: ordinal(day),
      B: MONTHS[month],
      b: MONTHS[month].slice(0, 3),
      A: DAYS[date.getUTCDay()],
      a: DAYS[date.getUTCDay()].slice(0, 3)
    };
    return renderPattern(pattern, (token) => (tokens[token] !== undefined ? { text: tokens[token] } : undefined));
  }

  function stars(value, pad) {
    const full = Math.max(0, Math.min(5, Math.floor(value / 20)));
    const half = full < 5 && value % 20 >= 10 ? 1 : 0;
    return "★".repeat(full) + "⯪".repeat(half) + (pad ? "☆".repeat(5 - full - half) : "");
  }

  // --------------------------------------------------------------- modifiers

  const STRING_MODIFIERS = {
    upper: (v) => v.toUpperCase(),
    lower: (v) => v.toLowerCase(),
    trim: (v) => v.trim(),
    title: (v) =>
      v
        .split(" ")
        .map((w) => w.toLowerCase())
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
    length: (v) => String(v.length),
    reverse: (v) => Array.from(v).reverse().join(""),
    base64: base64,
    string: (v) => v,
    smallcaps: (v) =>
      Array.from(v)
        .map((ch) => SMALL_CAPS[ch.toUpperCase()] || ch)
        .join(""),
    subscript: (v) => mapChars(v, DIGITS, SUBSCRIPT),
    superscript: (v) => mapChars(v, DIGITS, SUPERSCRIPT),
    languagecode: languageCode,
    languageemoji: languageEmoji
  };

  const sortWith = (ascending) => (list) =>
    list.slice().sort((a, b) => {
      const result =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), undefined, { numeric: true });
      return ascending ? result : -result;
    });

  const ARRAY_MODIFIERS = {
    join: (v) => v.join(", "),
    length: (v) => String(v.length),
    first: (v) => (v.length ? String(v[0]) : ""),
    last: (v) => (v.length ? String(v[v.length - 1]) : ""),
    random: (v) => (v.length ? String(v[Math.floor(Math.random() * v.length)]) : ""),
    sort: sortWith(true),
    rsort: sortWith(false),
    lsort: (v) => v.slice().sort(),
    reverse: (v) => v.slice().reverse(),
    unique: (v) => {
      const seen = {};
      return v.filter((item) => {
        const key = String(item).toLowerCase();
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });
    },
    string: (v) => v.toString(),
    languagecode: (v) => mapLanguages(v, languageCode),
    languageemoji: (v) => mapLanguages(v, languageEmoji)
  };

  const NUMBER_MODIFIERS = {
    hex: (v) => v.toString(16),
    octal: (v) => v.toString(8),
    binary: (v) => v.toString(2),
    bytes: (v) => formatBytes(v, 1000),
    bytes10: (v) => formatBytes(v, 1000),
    sbytes: (v) => formatBytes(v, 1000, "smart"),
    sbytes10: (v) => formatBytes(v, 1000, "smart"),
    bytes2: (v) => formatBytes(v, 1024),
    sbytes2: (v) => formatBytes(v, 1024, "smart"),
    rbytes: (v) => formatBytes(v, 1000, "round"),
    rbytes10: (v) => formatBytes(v, 1000, "round"),
    rbytes2: (v) => formatBytes(v, 1024, "round"),
    bitrate: (v) => formatBitrate(v),
    rbitrate: (v) => formatBitrate(v, "round"),
    sbitrate: (v) => formatBitrate(v, "smart"),
    string: (v) => v.toString(),
    time: (v) => formatDuration(toMs(v)),
    star: (v) => stars(v, false),
    pstar: (v) => stars(v, true)
  };

  /** Quoted arguments, in order: `('a', "b")` gives a and b. */
  function quoted(inner) {
    const args = [];
    const pattern = /"([^"]*)"|'([^']*)'/g;
    let m;
    while ((m = pattern.exec(inner)) !== null) args.push(m[1] !== undefined ? m[1] : m[2]);
    return args;
  }

  /** `{section.property}` references outside quotes. */
  function references(inner) {
    const bare = inner.replace(/"[^"]*"|'[^']*'/g, "");
    const found = [];
    const pattern = /\{\s*([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*\}/g;
    let m;
    while ((m = pattern.exec(bare)) !== null) if (found.indexOf(m[1]) === -1) found.push(m[1]);
    return found;
  }

  function unquote(arg) {
    const q = arg.charAt(0);
    return arg.length >= 2 && (q === "'" || q === '"') && arg.charAt(arg.length - 1) === q ? arg.slice(1, -1) : undefined;
  }

  function listArgument(literals, refs, scope, lower) {
    const out = literals.slice();
    refs.forEach((ref) => {
      const value = lookup(scope, ref);
      const list = Array.isArray(value) ? value : isPresent(value) ? [value] : [];
      list.forEach((item) => out.push(lower ? String(item).toLowerCase() : String(item)));
    });
    return out;
  }

  function replaceIn(value, search, replacement) {
    if (typeof value === "string") return capped(value.split(search).join(replacement));
    const target = search.toLowerCase();
    return value.map((item) => (String(item).toLowerCase() === target ? replacement : item));
  }

  const replaceable = (v) => typeof v === "string" || Array.isArray(v);

  function compileCheck(lower) {
    const exact = lower === "istrue" || lower === "isfalse" || lower === "exists";
    let operator = null;
    for (let i = 0; i < PREFIXES.length && !exact && !operator; i++) {
      if (lower.indexOf(PREFIXES[i]) === 0) operator = PREFIXES[i];
    }
    if (!exact && !operator) return null;
    const rawCheck = operator ? lower.slice(operator.length) : "";
    return (value) => {
      if (!isPresent(value)) return false;
      if (lower === "istrue") return value === true;
      if (lower === "isfalse") return value === false;
      if (exact) return true;
      const list = Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : null;
      const text = String(value).toLowerCase();
      const check = /\s/.test(text) ? rawCheck : rawCheck.replace(/\s/g, "");
      const numericValue = Number(text.replace(/,\s/g, ""));
      const numericCheck = Number(check.replace(/,\s/g, ""));
      const numeric = ["<", "<=", ">", ">=", "="].indexOf(operator) !== -1 && !isNaN(numericValue) && !isNaN(numericCheck);
      if (numeric) {
        if (operator === "=") return numericValue === numericCheck;
        if (operator === ">=") return numericValue >= numericCheck;
        if (operator === "<=") return numericValue <= numericCheck;
        if (operator === ">") return numericValue > numericCheck;
        return numericValue < numericCheck;
      }
      if (operator === "$") return list ? list[0] === check : text.indexOf(check) === 0;
      if (operator === "^") return list ? list[list.length - 1] === check : text.slice(text.length - check.length) === check;
      if (operator === "~") return list ? list.indexOf(check) !== -1 : text.indexOf(check) !== -1;
      if (operator === "=") return text === check;
      if (operator === ">=") return text >= check;
      if (operator === "<=") return text <= check;
      if (operator === ">") return text > check;
      return text < check;
    };
  }

  function compileCall(source, lower) {
    const open = source.indexOf("(");
    if (open === -1 || source.charAt(source.length - 1) !== ")") return null;
    const name = lower.slice(0, open).trim();
    const inner = source.slice(open + 1, -1);
    if (name === "replace") {
      // The two arguments are split at the separator between them, not
      // paired up by quotes, so a quote inside one stays literal.
      const body = inner.trim();
      const bare = /^\{([^}]+)\}\s*,\s*(['"])([\s\S]*)\2$/.exec(body);
      const open = body.charAt(0);
      const close = body.charAt(body.length - 1);
      const parts =
        !bare && body.length >= 2 && (open === "'" || open === '"') && (close === "'" || close === '"')
          ? body.slice(1, -1).split(new RegExp(open + "\\s*,\\s*" + close))
          : [];
      const search = parts.length === 2 && parts[0] ? parts[0] : undefined;
      const replacement = bare ? bare[3] : parts[1];
      const ref = /^\{\s*([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*\}$/.exec(search || "");
      const field = bare ? bare[1].trim() : ref && ref[1];
      if (field) {
        // The search key is a field: replace whatever it holds.
        return (value, scope) => {
          if (!replaceable(value)) return undefined;
          const found = lookup(scope, field);
          return isPresent(found) && !Array.isArray(found) ? replaceIn(value, String(found), replacement) : value;
        };
      }
      if (search === undefined) return (value) => (replaceable(value) ? value : undefined);
      return (value) => (replaceable(value) ? replaceIn(value, search, replacement) : undefined);
    }
    if (name === "remove" || name === "keep") {
      const args = quoted(inner).filter(Boolean);
      const refs = references(inner);
      const keeping = name === "keep";
      return (value, scope) => {
        if (typeof value === "string") {
          if (keeping) return undefined;
          return listArgument(args, refs, scope, false).reduce((text, target) => text.split(target).join(""), value);
        }
        if (Array.isArray(value)) {
          const set = listArgument(args.map((a) => a.toLowerCase()), refs, scope, true);
          return value.filter((item) => (set.indexOf(String(item).toLowerCase()) !== -1) === keeping);
        }
        return undefined;
      };
    }
    if (name === "join") {
      const separator = unquote(inner.trim());
      if (separator === undefined) return null;
      const sep = separator.split("{tools.newLine}").join(NEW_LINE);
      return (value) => (Array.isArray(value) ? value.join(sep) : undefined);
    }
    if (name === "truncate") {
      const limit = parseInt(inner, 10);
      if (isNaN(limit) || limit < 0) return null;
      return (value) => {
        if (typeof value !== "string") return undefined;
        const chars = Array.from(value);
        return chars.length <= limit ? value : chars.slice(0, limit).join("").replace(/\s+$/, "") + "…";
      };
    }
    if (name === "slice") {
      const parts = inner.split(",").map((p) => parseInt(p.trim(), 10));
      if (isNaN(parts[0])) return null;
      const end = parts.length > 1 && !isNaN(parts[1]) ? parts[1] : undefined;
      return (value) => (Array.isArray(value) ? value.slice(parts[0], end) : undefined);
    }
    if (name === "default") {
      const fallback = unquote(inner.trim());
      if (fallback === undefined) return null;
      return (value) => (isPresent(value) ? value : fallback);
    }
    if (name === "trim") {
      const chars = unquote(inner.trim());
      if (chars === undefined) return null;
      return (value) => {
        if (typeof value !== "string") return undefined;
        const points = Array.from(value);
        let start = 0;
        let end = points.length;
        while (start < end && chars.indexOf(points[start]) !== -1) start++;
        while (end > start && chars.indexOf(points[end - 1]) !== -1) end--;
        return points.slice(start, end).join("");
      };
    }
    if (name === "translate") {
      const args = quoted(inner);
      if (args.length < 2) return null;
      return (value) => (typeof value === "string" ? mapChars(value, args[0], args[1]) : undefined);
    }
    if (name === "in") {
      const args = quoted(inner).map((a) => a.toLowerCase());
      const refs = references(inner);
      if (!args.length && !refs.length) return null;
      return (value, scope) => {
        if (value === null || value === undefined) return false;
        const set = listArgument(args, refs, scope, true);
        if (Array.isArray(value)) return value.some((item) => set.indexOf(String(item).toLowerCase()) !== -1);
        return set.indexOf(String(value).toLowerCase()) !== -1;
      };
    }
    if (name === "time") {
      const pattern = unquote(inner.trim());
      if (pattern === undefined) return null;
      return (value) => (typeof value === "number" ? durationPattern(toMs(value), pattern) : undefined);
    }
    if (name === "date") {
      const pattern = unquote(inner.trim());
      if (pattern === undefined) return null;
      return (value) => (typeof value === "string" ? datePattern(value, pattern) : undefined);
    }
    if (name === "where" || name === "pluck" || name === "each") {
      // Track lists: a YouTube video has no probed tracks, so the lists these
      // work on are always empty, and each gives an empty list back.
      return (value) => (Array.isArray(value) && value.length === 0 ? [] : undefined);
    }
    return null;
  }

  function compilePlain(lower) {
    return (value) => {
      let table = null;
      if (typeof value === "string") table = STRING_MODIFIERS;
      else if (Array.isArray(value)) table = ARRAY_MODIFIERS;
      else if (typeof value === "number") table = NUMBER_MODIFIERS;
      else if (typeof value === "boolean") table = { string: (v) => String(v) };
      return table && Object.prototype.hasOwnProperty.call(table, lower) ? table[lower](value) : undefined;
    };
  }

  function compileModifier(source) {
    const lower = source.toLowerCase();
    return compileCheck(lower) || compileCall(source, lower) || compilePlain(lower);
  }

  // ------------------------------------------------------------------ parser

  const IDENT = /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/;

  /**
   * The index just past the quoted string starting at `start`, skipping any
   * `{...}` inside it whole, so a nested expression's quotes never end it.
   */
  function skipQuoted(text, start) {
    const quote = text[start];
    let i = start + 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") i += 2;
      else if (ch === quote) return i + 1;
      else if (ch === "{") {
        const end = skipBlock(text, i);
        i = end === -1 ? i + 1 : end;
      } else i++;
    }
    return -1;
  }

  /** The index just past the `{...}` or `{?...?}` starting at `start`, or -1. */
  function skipBlock(text, start) {
    if (text[start + 1] === "?") {
      let i = start + 2;
      while (i < text.length) {
        if (text[i] === "?" && text[i + 1] === "}") return i + 2;
        if (text[i] === "{") {
          const end = skipBlock(text, i);
          i = end === -1 ? i + 1 : end;
        } else i++;
      }
      return -1;
    }
    let i = start + 1;
    let parens = 0;
    // The last two characters other than spaces: a quote opens a string only
    // in an argument list or as a branch, after `[` or `||`. Elsewhere it is
    // an apostrophe in a check such as `::~don't`.
    let prev = "";
    let prev2 = "";
    while (i < text.length) {
      const ch = text[i];
      if ((ch === '"' || ch === "'") && (parens > 0 || prev === "[" || (prev === "|" && prev2 === "|"))) {
        const end = skipQuoted(text, i);
        if (end === -1) return -1;
        i = end;
        prev2 = prev;
        prev = ch;
        continue;
      }
      if (ch === "(") parens++;
      else if (ch === ")") parens = Math.max(0, parens - 1);
      else if (ch === "{") {
        const end = skipBlock(text, i);
        if (end === -1) return -1;
        i = end;
        prev2 = prev;
        prev = "}";
        continue;
      } else if (ch === "}" && parens === 0) return i + 1;
      if (!/\s/.test(ch)) {
        prev2 = prev;
        prev = ch;
      }
      i++;
    }
    return -1;
  }

  /** Splits on `::` outside quotes, parentheses and braces. */
  function splitChain(body) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let from = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
      } else if ((ch === '"' || ch === "'") && depth > 0) quote = ch;
      else if (ch === "(" || ch === "{") depth++;
      else if (ch === ")" || ch === "}") depth--;
      else if (ch === ":" && body[i + 1] === ":" && depth === 0) {
        parts.push(body.slice(from, i));
        from = i + 2;
        i++;
      }
    }
    parts.push(body.slice(from));
    return parts.map((p) => p.trim());
  }

  /** The branch texts of `["a"||"b"||"c"]`, or null. */
  function parseBranches(block) {
    const branches = [];
    let i = 1;
    for (;;) {
      while (/\s/.test(block[i] || "")) i++;
      const end = block[i] === '"' ? skipQuoted(block, i) : -1;
      if (end === -1) return null;
      branches.push(block.slice(i + 1, end - 1).replace(/\\"/g, '"'));
      i = end;
      while (/\s/.test(block[i] || "")) i++;
      if (block.slice(i, i + 2) === "||") {
        i += 2;
        continue;
      }
      if (block[i] === "]" && i === block.length - 1 && branches.length >= 2 && branches.length <= 3) return branches;
      return null;
    }
  }

  /** The start of a trailing `["..."||...]` block in an expression body, or -1. */
  function branchStart(body) {
    let depth = 0;
    let quote = null;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
      } else if ((ch === '"' || ch === "'") && depth > 0) quote = ch;
      else if (ch === "(" || ch === "{") depth++;
      else if (ch === ")" || ch === "}") depth--;
      else if (ch === "[" && depth === 0 && /^\[\s*"/.test(body.slice(i))) return i;
    }
    return -1;
  }

  function parseOperand(token) {
    const literal = unquote(token);
    if (literal !== undefined) return { literal: literal };
    if (!IDENT.test(token)) return null;
    const dot = token.indexOf(".");
    return { section: token.slice(0, dot).toLowerCase(), property: token.slice(dot + 1).toLowerCase(), source: token };
  }

  /** An expression node, or null when the braces hold no expression. */
  function parseExpression(body, depth) {
    let chain = body.trim();
    let check = null;
    const at = branchStart(chain);
    if (at !== -1) {
      const branches = parseBranches(chain.slice(at));
      if (!branches) return null;
      check = branches.map((b) => (depth >= MAX_DEPTH ? [{ kind: "text", text: b }] : parse(b, depth + 1)));
      chain = chain.slice(0, at).trim();
    }
    const tokens = splitChain(chain);
    const first = parseOperand(tokens[0]);
    if (!first) return null;
    if (first.section === "tools" && tokens.length === 1 && !check) {
      if (first.property === "newline") return { kind: "tool", text: NEW_LINE };
      if (first.property === "removeline") return { kind: "tool", text: REMOVE_LINE };
    }
    const operands = [{ node: first, modifiers: [] }];
    const joins = [];
    for (let i = 1; i < tokens.length; i++) {
      const lower = tokens[i].toLowerCase();
      if (JOINERS.indexOf(lower) !== -1 && i + 1 < tokens.length) {
        const next = parseOperand(tokens[i + 1]);
        if (!next) return null;
        joins.push(lower);
        operands.push({ node: next, modifiers: [] });
        i++;
      } else {
        operands[operands.length - 1].modifiers.push({ source: tokens[i], apply: compileModifier(tokens[i]) });
      }
    }
    return { kind: "expression", operands: operands, joins: joins, check: check };
  }

  /** A template's nodes: text, tools, groups and expressions. */
  function parse(text, depth) {
    const nodes = [];
    let buffer = "";
    let i = 0;
    const flush = () => {
      if (buffer) nodes.push({ kind: "text", text: buffer.replace(/\\n/g, "\n") });
      buffer = "";
    };
    while (i < text.length) {
      if (text[i] !== "{") {
        buffer += text[i++];
        continue;
      }
      const end = skipBlock(text, i);
      if (end === -1) {
        buffer += text[i++];
        continue;
      }
      if (text[i + 1] === "?") {
        flush();
        nodes.push({ kind: "group", nodes: parse(text.slice(i + 2, end - 2), depth) });
      } else {
        const node = parseExpression(text.slice(i + 1, end - 1), depth);
        if (!node) {
          buffer += text.slice(i, end);
          i = end;
          continue;
        }
        flush();
        nodes.push(node);
      }
      i = end;
    }
    flush();
    return nodes;
  }

  // -------------------------------------------------------------- rendering

  function lookup(scope, path) {
    const dot = path.indexOf(".");
    const section = scope[path.slice(0, dot).toLowerCase()];
    if (!section) return undefined;
    return section[path.slice(dot + 1).toLowerCase()];
  }

  /** `{ result, present }`, or `{ error }`. */
  function resolveOperand(operand, scope) {
    const node = operand.node;
    let value;
    let present = true;
    if (node.literal !== undefined) value = node.literal;
    else {
      const section = scope[node.section];
      if (!section) return { error: "{unknown_variableType(" + node.source.split(".")[0] + ")}" };
      if (!Object.prototype.hasOwnProperty.call(section, node.property)) {
        return { error: "{unknown_propertyName(" + node.source + ")}" };
      }
      value = section[node.property];
      if (typeof value === "string") value = scrub(value);
      else if (Array.isArray(value)) value = value.map((item) => (typeof item === "string" ? scrub(item) : item));
      present =
        isPresent(value) || operand.modifiers.some((m) => m.source.toLowerCase().indexOf("default(") === 0);
    }
    for (let i = 0; i < operand.modifiers.length; i++) {
      const input = value;
      const output = operand.modifiers[i].apply(input, scope);
      if (output === undefined) {
        if (input === null || input === undefined) return { result: "", present: present };
        return { error: "{unknown_" + typeName(input) + "_modifier(" + operand.modifiers[i].source + ")}" };
      }
      value = typeof output === "string" ? capped(output) : output;
    }
    return { result: value, present: present };
  }

  function presence(operand, scope) {
    if (operand.node.literal !== undefined) return true;
    if (operand.modifiers.some((m) => m.source.toLowerCase().indexOf("default(") === 0)) return true;
    const section = scope[operand.node.section];
    return section ? isPresent(section[operand.node.property]) : false;
  }

  function combine(join, a, b) {
    if (join === "and") return a && b;
    if (join === "or") return a || b;
    if (join === "xor") return (a || b) && !(a && b);
    if (join === "neq") return a !== b;
    if (join === "equal") return a === b;
    if (join === "left") return a;
    return b;
  }

  function resolveExpression(node, scope) {
    let result = resolveOperand(node.operands[0], scope);
    if (node.operands.length === 1) return result;
    let present = presence(node.operands[0], scope);
    for (let i = 1; i < node.operands.length; i++) {
      const next = presence(node.operands[i], scope);
      present = node.joins[i - 1] === "or" ? present || next : present && next;
    }
    const uniform = node.joins.every((j) => j === node.joins[0]) && (node.joins[0] === "and" || node.joins[0] === "or");
    for (let i = 1; i < node.operands.length; i++) {
      if (result.error !== undefined) return result;
      const join = node.joins[i - 1];
      if (uniform && join === "and" && result.result === false) return { result: false, present: present };
      if (uniform && join === "or" && result.result === true) return { result: true, present: present };
      const next = resolveOperand(node.operands[i], scope);
      if (next.error !== undefined) return next;
      result = { result: combine(join, result.result, next.result) };
    }
    return { result: result.result, present: present };
  }

  function renderNodes(nodes, scope, guard) {
    let out = "";
    nodes.forEach((node) => {
      out += renderNode(node, scope, guard);
    });
    return out;
  }

  function renderNode(node, scope, guard) {
    if (node.kind === "text" || node.kind === "tool") return node.text;
    if (node.kind === "group") {
      for (let i = 0; i < node.nodes.length; i++) {
        const child = node.nodes[i];
        if (child.kind === "expression" && !child.check) {
          const resolved = resolveExpression(child, scope);
          if (resolved.error === undefined && resolved.present === false) return "";
        }
      }
      return renderNodes(node.nodes, scope, guard);
    }
    const resolved = resolveExpression(node, scope);
    if (resolved.error !== undefined) return resolved.error;
    if (!node.check) {
      const value = resolved.result;
      const text = value === null || value === undefined ? "" : String(value);
      return guard ? guard(text) : text;
    }
    if (!isPresent(resolved.result)) return node.check[2] ? renderNodes(node.check[2], scope, guard) : "";
    if (resolved.result !== true && resolved.result !== false) {
      return "{cannot_coerce_boolean_for_check_from(" + resolved.result + ")}";
    }
    return renderNodes(resolved.result ? node.check[0] : node.check[1], scope, guard);
  }

  // Parsed templates, kept for reuse; readers' own templates are many, so
  // the cache starts over rather than grow without end.
  let cache = {};
  let cached = 0;

  /**
   * Renders a template against a scope: `{ section: { property: value } }`,
   * with every property the template may name present, null when missing.
   * `guard` sees each value's text on its way out.
   */
  function render(template, scope, guard) {
    const source = String(template === null || template === undefined ? "" : template);
    if (!Object.prototype.hasOwnProperty.call(cache, source)) {
      if (++cached > 200) {
        cache = {};
        cached = 1;
      }
      cache[source] = parse(source, 0);
    }
    const lowered = {};
    Object.keys(scope).forEach((section) => {
      const fields = {};
      Object.keys(scope[section]).forEach((key) => {
        fields[key.toLowerCase()] = scope[section][key];
      });
      lowered[section.toLowerCase()] = fields;
    });
    return renderNodes(cache[source], lowered, guard)
      .split("\n")
      .filter((line) => line.trim() !== "" && line.indexOf(REMOVE_LINE) === -1)
      .join("\n")
      .split(NEW_LINE)
      .join("\n");
  }

  return { render: render };
}

module.exports = { createFormatter };
