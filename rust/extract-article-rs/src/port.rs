//! The Rust port of `src/features/feeds/extract-article.ts`: sanitize-html 2.18 with the
//! article options, over a port of the htmlparser2 12 tokenizer and tag stack it runs on.
//!
//! The JS string arrives as UTF-16 code units and is held as WTF-8: UTF-8 that also encodes
//! lone surrogates, which JS strings may hold and Rust strings may not. The tokenizer reads
//! bytes: every byte it compares is ASCII, so byte offsets cut the input where htmlparser2's
//! UTF-16 offsets do. Text reaches the sanitizer in the same chunks as in htmlparser2, because
//! the text of a discarded `<iframe>` is sanitized again chunk by chunk.

#![forbid(unsafe_code)]

use htmlize::ENTITIES;

/// Port of `extractArticle` (`src/features/feeds/extract-article.ts:48`).
pub fn extract_article(content: Option<Vec<u16>>) -> Result<Vec<u16>, String> {
    let html = wtf8(&content.unwrap_or_default());
    Ok(utf16(&sanitize(&html, 0)))
}

fn push_code_point(out: &mut Vec<u8>, cp: u32) {
    match char::from_u32(cp) {
        Some(c) => out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes()),
        None => out.extend([
            0xe0 | (cp >> 12) as u8,
            0x80 | (cp >> 6 & 0x3f) as u8,
            0x80 | (cp & 0x3f) as u8,
        ]),
    }
}

fn wtf8(units: &[u16]) -> Vec<u8> {
    if let Ok(text) = String::from_utf16(units) {
        return text.into_bytes();
    }
    let mut out = Vec::with_capacity(units.len() + units.len() / 2);
    for unit in char::decode_utf16(units.iter().copied()) {
        let cp = unit.map_or_else(|e| u32::from(e.unpaired_surrogate()), u32::from);
        push_code_point(&mut out, cp);
    }
    out
}

/// The code points of WTF-8 text with the byte length of each.
fn code_points(bytes: &[u8]) -> impl Iterator<Item = (u32, usize)> + '_ {
    let mut at = 0;
    std::iter::from_fn(move || {
        let lead = *bytes.get(at)?;
        let length = match lead {
            0..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            _ => 4,
        };
        let mut cp = u32::from(lead & [0x7f, 0x1f, 0x0f, 0x07][length - 1]);
        for byte in bytes.iter().skip(at + 1).take(length - 1) {
            cp = cp << 6 | u32::from(byte & 0x3f);
        }
        at += length;
        Some((cp, length))
    })
}

fn utf16(bytes: &[u8]) -> Vec<u16> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.encode_utf16().collect();
    }
    let mut out = Vec::with_capacity(bytes.len());
    for (cp, _) in code_points(bytes) {
        match char::from_u32(cp) {
            Some(c) => out.extend_from_slice(c.encode_utf16(&mut [0; 2])),
            None => out.push(cp as u16),
        }
    }
    out
}

fn is_allowed(name: &[u8]) -> bool {
    matches!(
        name,
        b"address"
            | b"article"
            | b"aside"
            | b"footer"
            | b"header"
            | b"h1"
            | b"h2"
            | b"h3"
            | b"h4"
            | b"h5"
            | b"h6"
            | b"hgroup"
            | b"main"
            | b"nav"
            | b"section"
            | b"blockquote"
            | b"dd"
            | b"div"
            | b"dl"
            | b"dt"
            | b"figcaption"
            | b"figure"
            | b"hr"
            | b"li"
            | b"menu"
            | b"ol"
            | b"p"
            | b"pre"
            | b"ul"
            | b"a"
            | b"abbr"
            | b"b"
            | b"bdi"
            | b"bdo"
            | b"br"
            | b"cite"
            | b"code"
            | b"data"
            | b"dfn"
            | b"em"
            | b"i"
            | b"kbd"
            | b"mark"
            | b"q"
            | b"rb"
            | b"rp"
            | b"rt"
            | b"rtc"
            | b"ruby"
            | b"s"
            | b"samp"
            | b"small"
            | b"span"
            | b"strong"
            | b"sub"
            | b"sup"
            | b"time"
            | b"u"
            | b"var"
            | b"wbr"
            | b"caption"
            | b"col"
            | b"colgroup"
            | b"table"
            | b"tbody"
            | b"td"
            | b"tfoot"
            | b"th"
            | b"thead"
            | b"tr"
            | b"audio"
            | b"img"
            | b"picture"
            | b"source"
            | b"video"
    )
}
fn is_non_text(name: &[u8]) -> bool {
    matches!(
        name,
        b"script" | b"style" | b"textarea" | b"option" | b"xmp"
    )
}
fn is_self_closing(name: &[u8]) -> bool {
    matches!(
        name,
        b"img"
            | b"br"
            | b"hr"
            | b"area"
            | b"base"
            | b"basefont"
            | b"input"
            | b"link"
            | b"meta"
            | b"col"
    )
}
fn is_void(name: &[u8]) -> bool {
    matches!(
        name,
        b"area"
            | b"base"
            | b"basefont"
            | b"br"
            | b"col"
            | b"command"
            | b"embed"
            | b"frame"
            | b"hr"
            | b"img"
            | b"input"
            | b"isindex"
            | b"keygen"
            | b"link"
            | b"meta"
            | b"param"
            | b"source"
            | b"track"
            | b"wbr"
    )
}
fn is_integration(name: &[u8]) -> bool {
    matches!(
        name,
        b"mi"
            | b"mo"
            | b"mn"
            | b"ms"
            | b"mtext"
            | b"annotation-xml"
            | b"foreignObject"
            | b"desc"
            | b"title"
    )
}
const SVG_NAMES: &[&str] = &[
    "altGlyph",
    "altGlyphDef",
    "altGlyphItem",
    "animateColor",
    "animateMotion",
    "animateTransform",
    "clipPath",
    "feBlend",
    "feColorMatrix",
    "feComponentTransfer",
    "feComposite",
    "feConvolveMatrix",
    "feDiffuseLighting",
    "feDisplacementMap",
    "feDistantLight",
    "feDropShadow",
    "feFlood",
    "feFuncA",
    "feFuncB",
    "feFuncG",
    "feFuncR",
    "feGaussianBlur",
    "feImage",
    "feMerge",
    "feMergeNode",
    "feMorphology",
    "feOffset",
    "fePointLight",
    "feSpecularLighting",
    "feSpotLight",
    "feTile",
    "feTurbulence",
    "foreignObject",
    "glyphRef",
    "linearGradient",
    "radialGradient",
    "textPath",
];
const C1: [u32; 32] = [
    8364, 0, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 0, 381, 0, 0, 8216,
    8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 0, 382, 376,
];

const CDATA: &[u8] = b"CDATA[";
const CDATA_END: &[u8] = b"]]>";
const COMMENT_END: &[u8] = b"--!>";
const DOCTYPE: &[u8] = b"doctype";
const NOEMBED_END: &[u8] = b"</noembed";
const NOFRAMES_END: &[u8] = b"</noframes";
const PLAINTEXT: &[u8] = b"</plaintext";
const SCRIPT_END: &[u8] = b"</script";
const STYLE_END: &[u8] = b"</style";
const TITLE_END: &[u8] = b"</title";
const TEXTAREA_END: &[u8] = b"</textarea";

fn implies_close(name: &[u8]) -> &'static [&'static [u8]] {
    match name {
        b"tr" => &[b"tr", b"th", b"td"],
        b"th" => &[b"th"],
        b"td" => &[b"thead", b"th", b"td"],
        b"body" => &[b"head", b"link", b"script"],
        b"a" => &[b"a"],
        b"li" => &[b"li"],
        b"h1" | b"h2" | b"h3" | b"h4" | b"h5" | b"h6" => {
            &[b"h1", b"h2", b"h3", b"h4", b"h5", b"h6", b"p"]
        }
        b"select" | b"input" | b"output" | b"button" | b"datalist" | b"textarea" => &[
            b"input",
            b"option",
            b"optgroup",
            b"select",
            b"button",
            b"datalist",
            b"textarea",
        ],
        b"option" => &[b"option"],
        b"optgroup" => &[b"optgroup", b"option"],
        b"dd" | b"dt" => &[b"dd", b"dt"],
        b"rt" | b"rp" => &[b"rt", b"rp"],
        b"tbody" | b"tfoot" => &[b"thead", b"tbody"],
        b"p" | b"address" | b"article" | b"aside" | b"blockquote" | b"details" | b"div" | b"dl"
        | b"fieldset" | b"figcaption" | b"figure" | b"footer" | b"form" | b"header" | b"hr"
        | b"main" | b"nav" | b"ol" | b"pre" | b"section" | b"table" | b"ul" => &[b"p"],
        _ => &[],
    }
}

fn special_sequence(lower: u8) -> Option<&'static [u8]> {
    match lower {
        b'i' => Some(b"</iframe"),
        b'n' => Some(NOEMBED_END),
        b'p' => Some(PLAINTEXT),
        b's' => Some(SCRIPT_END),
        b't' => Some(TITLE_END),
        b'x' => Some(b"</xmp"),
        _ => None,
    }
}

/// JS `toLowerCase`: lone surrogates stay as they are.
fn lowercase(text: &[u8]) -> Vec<u8> {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    let mut out = Vec::with_capacity(text.len());
    for chunk in text.utf8_chunks() {
        out.extend_from_slice(chunk.valid().to_lowercase().as_bytes());
        out.extend_from_slice(chunk.invalid());
    }
    out
}

fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\n' | b'\t' | 0x0c | b'\r')
}

fn ends_tag_section(c: u8) -> bool {
    c == b'/' || c == b'>' || is_ws(c)
}

/// Decodes the character reference at `amp` as htmlparser2's `entities` decoder does:
/// the bytes it consumes, `&` included, and the text, or `None` to keep `&` as text.
fn decode_entity(b: &[u8], amp: usize, attribute: bool) -> Option<(usize, Vec<u8>)> {
    let rest = &b[amp + 1..];
    if rest.first() == Some(&b'#') {
        let hex = matches!(rest.get(1), Some(b'x' | b'X'));
        let start = if hex { 2 } else { 1 };
        let radix = if hex { 16 } else { 10 };
        let digits = rest[start..]
            .iter()
            .take_while(|c| (**c as char).is_digit(radix))
            .count();
        if digits == 0 {
            return None;
        }
        let mut cp: u32 = 0;
        for c in &rest[start..start + digits] {
            let digit = (*c as char).to_digit(radix).unwrap_or(0);
            cp = cp.saturating_mul(radix).saturating_add(digit);
        }
        let semicolon = usize::from(rest.get(start + digits) == Some(&b';'));
        let cp = match cp {
            0 | 0xd800..=0xdfff | 0x11_0000.. => 0xfffd,
            128..=159 if C1[cp as usize - 128] != 0 => C1[cp as usize - 128],
            _ => cp,
        };
        let mut text = Vec::new();
        push_code_point(&mut text, cp);
        return Some((1 + start + digits + semicolon, text));
    }
    let n = rest
        .iter()
        .take(32)
        .take_while(|c| c.is_ascii_alphanumeric())
        .count();
    let mut key = Vec::with_capacity(n + 2);
    key.push(b'&');
    key.extend_from_slice(&rest[..n]);
    if rest.get(n) == Some(&b';') {
        key.push(b';');
        if let Some(value) = ENTITIES.get(key.as_slice()) {
            return Some((n + 2, value.to_vec()));
        }
    }
    let (k, value) = (1..=n)
        .rev()
        .find_map(|k| ENTITIES.get(&key[..=k]).map(|v| (k, v)))?;
    let next = rest.get(k).copied();
    if attribute && next.is_some_and(|c| c == b'=' || c.is_ascii_alphanumeric()) {
        return None;
    }
    Some((k + 1, value.to_vec()))
}

/// `launder`'s `naughtyHref` with sanitize-html's schemes: http, https and mailto.
fn naughty(href: &[u8]) -> bool {
    let mut href: Vec<u8> = href.iter().copied().filter(|c| *c > b' ').collect();
    while let Some(open) = memchr::memmem::find(&href, b"<!--") {
        let Some(close) = memchr::memmem::find(&href[open + 4..], b"-->") else {
            break;
        };
        href.drain(open..open + 4 + close + 3);
    }
    if !href.first().is_some_and(u8::is_ascii_alphabetic) {
        return false;
    }
    let scheme = 1 + href[1..]
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'+'))
        .count();
    href.get(scheme) == Some(&b':')
        && !matches!(
            href[..scheme].to_ascii_lowercase().as_slice(),
            b"http" | b"https" | b"mailto"
        )
}

fn is_digits(value: &[u8]) -> bool {
    !value.is_empty() && value.iter().all(u8::is_ascii_digit)
}

fn is_float(value: &[u8]) -> bool {
    let value = value.strip_prefix(b"-").unwrap_or(value);
    let (mantissa, exponent) = match value.iter().position(|c| matches!(c, b'e' | b'E')) {
        Some(at) => (&value[..at], Some(&value[at + 1..])),
        None => (value, None),
    };
    let mantissa_ok = match mantissa.iter().position(|c| *c == b'.') {
        Some(at) => (at == 0 || is_digits(&mantissa[..at])) && is_digits(&mantissa[at + 1..]),
        None => is_digits(mantissa),
    };
    mantissa_ok
        && exponent
            .is_none_or(|e| is_digits(e.strip_prefix(b"+").or(e.strip_prefix(b"-")).unwrap_or(e)))
}

fn js_number(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_string()
}

fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | 0x0c | b'\r')
}

/// `parse-srcset`'s candidates that pass its descriptor checks, as `url w h d` (0 for none).
/// Like `parse-srcset`, it logs each candidate it drops to stdout.
fn parse_srcset(input: &[u8]) -> Vec<(Vec<u8>, f64, f64, f64)> {
    let (mut pos, mut candidates) = (0, Vec::new());
    loop {
        while pos < input.len() && (input[pos] == b',' || is_space(input[pos])) {
            pos += 1;
        }
        if pos >= input.len() {
            return candidates;
        }
        let start = pos;
        while pos < input.len() && !is_space(input[pos]) {
            pos += 1;
        }
        let mut url = input[start..pos].to_vec();
        let mut descriptors = Vec::new();
        if url.ends_with(b",") {
            let kept = url.iter().rposition(|c| *c != b',').map_or(0, |at| at + 1);
            url.truncate(kept);
        } else {
            while pos < input.len() && is_space(input[pos]) {
                pos += 1;
            }
            let (mut current, mut state) = (Vec::new(), 0);
            loop {
                let c = input.get(pos).copied();
                match (state, c) {
                    (0, Some(c)) if is_space(c) => {
                        if !current.is_empty() {
                            descriptors.push(std::mem::take(&mut current));
                            state = 2;
                        }
                    }
                    (0, Some(b',') | None) => {
                        pos += usize::from(c.is_some());
                        if !current.is_empty() {
                            descriptors.push(current);
                        }
                        break;
                    }
                    (0, Some(b'(')) | (1, Some(b')')) => {
                        current.push(c.unwrap_or_default());
                        state = 1 - state;
                    }
                    (1, None) => {
                        descriptors.push(current);
                        break;
                    }
                    (0 | 1, Some(c)) => current.push(c),
                    (_, None) => break,
                    (_, Some(c)) if is_space(c) => {}
                    (_, Some(_)) => {
                        state = 0;
                        pos -= 1;
                    }
                }
                pos += 1;
            }
        }
        let (mut w, mut d, mut h, mut error) = (0.0, 0.0, 0.0, false);
        for descriptor in &descriptors {
            let (value, last) = match descriptor.split_last() {
                Some((last, value)) if last.is_ascii() => (value, Some(*last)),
                _ => (&descriptor[..0], None),
            };
            let number: f64 = std::str::from_utf8(value)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(f64::NAN);
            if is_digits(value) && last == Some(b'w') {
                error |= w != 0.0 || d != 0.0 || number == 0.0;
                if number != 0.0 {
                    w = number;
                }
            } else if is_float(value) && last == Some(b'x') {
                error |= w != 0.0 || d != 0.0 || h != 0.0 || number < 0.0;
                if number >= 0.0 {
                    d = number;
                }
            } else if is_digits(value) && last == Some(b'h') {
                error |= h != 0.0 || d != 0.0 || number == 0.0;
                if number != 0.0 {
                    h = number;
                }
            } else {
                error = true;
            }
        }
        match descriptors.last() {
            Some(last) if error => println!(
                "Invalid srcset descriptor found in '{}' at '{}'.",
                String::from_utf16_lossy(&utf16(input)),
                String::from_utf16_lossy(&utf16(last))
            ),
            _ => candidates.push((url, w, h, d)),
        }
    }
}

fn sanitize_srcset(value: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    for (url, w, h, d) in parse_srcset(value) {
        if naughty(&url) {
            continue;
        }
        if !out.is_empty() {
            out.extend_from_slice(b", ");
        }
        out.extend_from_slice(&url);
        for (number, unit) in [(w, 'w'), (h, 'h'), (d, 'x')] {
            if number != 0.0 {
                out.extend_from_slice(format!(" {}{unit}", js_number(number)).as_bytes());
            }
        }
    }
    (!out.is_empty()).then_some(out)
}

fn escape_into(out: &mut Vec<u8>, text: &[u8], quote: bool) {
    let mut last = 0;
    while let Some(offset) = match quote {
        true => text[last..]
            .iter()
            .position(|c| matches!(c, b'&' | b'<' | b'>' | b'"')),
        false => memchr::memchr3(b'&', b'<', b'>', &text[last..]),
    } {
        let at = last + offset;
        let replacement: &[u8] = match text[at] {
            b'&' => b"&amp;",
            b'<' => b"&lt;",
            b'>' => b"&gt;",
            _ => b"&quot;",
        };
        out.extend_from_slice(&text[last..at]);
        out.extend_from_slice(replacement);
        last = at + 1;
    }
    out.extend_from_slice(&text[last..]);
}

type Attributes = Vec<(Vec<u8>, Vec<u8>)>;

fn set_attribute(attributes: &mut Attributes, name: &[u8], value: Vec<u8>) {
    match attributes.iter_mut().find(|(key, _)| key == name) {
        Some(slot) => slot.1 = value,
        None => attributes.push((name.to_vec(), value)),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Text,
    BeforeTagName,
    InTagName,
    InSelfClosingTag,
    BeforeClosingTagName,
    InClosingTagName,
    AfterClosingTagName,
    BeforeAttributeName,
    InAttributeName,
    AfterAttributeName,
    BeforeAttributeValue,
    InValueDq,
    InValueSq,
    InValueNq,
    BeforeDeclaration,
    InDeclaration,
    BeforeComment,
    CdataSequence,
    DeclarationSequence,
    InSpecialComment,
    InCommentLike,
    SpecialStartSequence,
    InSpecialTag,
    InPlainText,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Context {
    Html,
    Svg,
    Math,
}

struct Sanitizer<'a> {
    bytes: &'a [u8],
    state: State,
    section: isize,
    index: usize,
    special: bool,
    sequence: &'static [u8],
    matched: usize,
    stack: Vec<Vec<u8>>,
    contexts: Vec<Context>,
    tag_name: Vec<u8>,
    attributes: Option<Attributes>,
    attribute_name: Vec<u8>,
    attribute_value: Vec<u8>,
    out: Vec<u8>,
    frames: Vec<(Vec<u8>, bool)>,
    skip_text: u32,
    iframe_depth: u32,
}

fn sanitize(html: &[u8], iframe_depth: u32) -> Vec<u8> {
    let mut s = Sanitizer {
        bytes: html,
        state: State::Text,
        section: 0,
        index: 0,
        special: false,
        sequence: b"",
        matched: 0,
        stack: Vec::new(),
        contexts: vec![Context::Html],
        tag_name: Vec::new(),
        attributes: None,
        attribute_name: Vec::new(),
        attribute_value: Vec::new(),
        out: Vec::with_capacity(html.len() + html.len() / 8),
        frames: Vec::new(),
        skip_text: 0,
        iframe_depth,
    };
    s.run();
    s.out
}

impl<'a> Sanitizer<'a> {
    fn run(&mut self) {
        while self.index < self.bytes.len() {
            self.step(self.bytes[self.index]);
            self.index += 1;
        }
        let at = self.index as isize;
        let pending_text = matches!(self.state, State::Text | State::InPlainText)
            || (self.state == State::InSpecialTag && self.matched == 0);
        if self.section < at && pending_text {
            self.text_between(self.section, self.index);
            self.section = at;
        } else if self.section < at
            && matches!(
                self.state,
                State::InValueDq | State::InValueSq | State::InValueNq
            )
        {
            self.attribute_data(self.section, self.index);
            self.section = at;
        }
        self.trailing_data();
        for index in (0..self.stack.len()).rev() {
            let name = self.stack[index].clone();
            self.close_tag(&name);
        }
    }

    fn trailing_data(&mut self) {
        use State::*;
        let end = self.bytes.len();
        let markup = matches!(
            self.state,
            InCommentLike
                | BeforeDeclaration
                | InSpecialComment
                | BeforeComment
                | CdataSequence
                | DeclarationSequence
                | InDeclaration
        );
        let in_tag = matches!(
            self.state,
            InTagName
                | BeforeAttributeName
                | BeforeAttributeValue
                | AfterAttributeName
                | InAttributeName
                | InValueSq
                | InValueDq
                | InValueNq
                | InClosingTagName
        );
        if !markup && !in_tag && self.section < end as isize {
            self.text_between(self.section, end);
        }
    }

    fn step(&mut self, c: u8) {
        use State::*;
        match self.state {
            Text => self.in_text(c),
            InPlainText => self.index = self.bytes.len() - 1,
            SpecialStartSequence => self.special_start(c),
            InSpecialTag => self.in_special_tag(c),
            CdataSequence => self.cdata_sequence(c),
            DeclarationSequence => self.declaration_sequence(c),
            InValueDq => self.in_quoted_value(c, b'"'),
            InValueSq => self.in_quoted_value(c, b'\''),
            InValueNq => self.in_unquoted_value(c),
            InAttributeName => self.in_attribute_name(c),
            InCommentLike => self.in_comment_like(c),
            InSpecialComment | InDeclaration => self.skip_to_gt(c),
            BeforeAttributeName => self.before_attribute_name(c),
            InTagName => self.in_tag_name(c),
            InClosingTagName => self.in_closing_tag_name(c),
            BeforeTagName => self.before_tag_name(c),
            AfterAttributeName => self.after_attribute_name(c),
            BeforeAttributeValue => self.before_attribute_value(c),
            BeforeClosingTagName => self.before_closing_tag_name(c),
            AfterClosingTagName => self.skip_to_gt(c),
            InSelfClosingTag => self.in_self_closing_tag(c),
            BeforeDeclaration => self.before_declaration(c),
            BeforeComment => self.before_comment(c),
        }
    }

    fn slice(&self, start: isize, end: usize) -> &'a [u8] {
        let start = usize::try_from(start).unwrap_or(end);
        self.bytes.get(start..end).unwrap_or_default()
    }

    fn fast_forward_to(&mut self, target: u8) -> bool {
        match self.bytes[self.index + 1..]
            .iter()
            .position(|c| *c == target)
        {
            Some(offset) => {
                self.index += offset + 1;
                true
            }
            None => {
                self.index = self.bytes.len() - 1;
                false
            }
        }
    }

    fn resume_text(&mut self) {
        self.state = State::Text;
        self.section = self.index as isize + 1;
    }

    fn in_text(&mut self, c: u8) {
        if c == b'<' {
            if self.index as isize > self.section {
                self.text_between(self.section, self.index);
            }
            self.state = State::BeforeTagName;
            self.section = self.index as isize;
        } else if c == b'&' {
            self.entity(false);
        } else {
            self.skip_before(memchr::memchr2(b'<', b'&', &self.bytes[self.index..]));
        }
    }

    fn skip_before(&mut self, found: Option<usize>) {
        self.index = found.map_or(self.bytes.len(), |offset| self.index + offset) - 1;
    }

    fn entity(&mut self, attribute: bool) {
        let start = self.index;
        let Some((length, text)) = decode_entity(self.bytes, start, attribute) else {
            return;
        };
        if self.section < start as isize {
            if attribute {
                self.attribute_data(self.section, start);
            } else {
                self.text_between(self.section, start);
            }
        }
        self.index = start + length - 1;
        self.section = (start + length) as isize;
        if attribute {
            self.attribute_value.extend_from_slice(&text);
        } else {
            let mut at = 0;
            for (_, length) in code_points(&text) {
                self.on_text(&text[at..at + length]);
                at += length;
            }
        }
    }

    fn enter_tag_body(&mut self) {
        if self.sequence == PLAINTEXT {
            self.sequence = b"";
            self.state = State::InPlainText;
        } else if self.special {
            self.state = State::InSpecialTag;
            self.matched = 0;
        } else {
            self.state = State::Text;
        }
    }

    fn special_start(&mut self, c: u8) {
        let lower = c | 0x20;
        if self.matched < self.sequence.len() {
            if lower == self.sequence[self.matched] {
                self.matched += 1;
                return;
            }
            let switch = match (self.matched, self.sequence) {
                (3, SCRIPT_END) if lower == b't' => Some(STYLE_END),
                (3, TITLE_END) if lower == b'e' => Some(TEXTAREA_END),
                (4, NOEMBED_END) if lower == b'f' => Some(NOFRAMES_END),
                _ => None,
            };
            if let Some(sequence) = switch {
                self.sequence = sequence;
                self.matched += 1;
                return;
            }
        } else if ends_tag_section(c) {
            self.matched = 0;
            self.state = State::InTagName;
            self.in_tag_name(c);
            return;
        }
        self.special = false;
        self.sequence = b"";
        self.matched = 0;
        self.state = State::InTagName;
        self.in_tag_name(c);
    }

    fn cdata_sequence(&mut self, c: u8) {
        if c == CDATA[self.matched] {
            self.matched += 1;
            if self.matched == CDATA.len() {
                self.state = State::InCommentLike;
                self.sequence = CDATA_END;
                self.matched = 0;
                self.section = self.index as isize + 1;
            }
        } else {
            self.matched = 0;
            self.state = State::InSpecialComment;
            self.skip_to_gt(c);
        }
    }

    fn in_comment_like(&mut self, c: u8) {
        let comment = self.sequence == COMMENT_END;
        let at_start = self.index as isize == self.section + self.matched as isize;
        if comment && c == b'>' && (self.matched == 2 || (self.matched <= 1 && at_start)) {
            self.matched = 0;
            self.resume_text();
        } else if comment && self.matched == COMMENT_END.len() - 1 && c != b'>' {
            self.matched = usize::from(c == b'-');
        } else if c == self.sequence[self.matched] {
            self.matched += 1;
            if self.matched == self.sequence.len() {
                if !comment && self.context() != Context::Html {
                    let value = self.slice(self.section, self.index - 2);
                    self.on_text(value);
                }
                self.matched = 0;
                self.resume_text();
            }
        } else if self.matched == 0 {
            if self.fast_forward_to(self.sequence[0]) {
                self.matched = 1;
            }
        } else if c != self.sequence[self.matched - 1] {
            self.matched = 0;
        }
    }

    fn in_special_tag(&mut self, c: u8) {
        if self.matched == self.sequence.len() {
            if ends_tag_section(c) {
                let end_of_text = self.index - self.sequence.len();
                if self.section < end_of_text as isize {
                    self.text_between(self.section, end_of_text);
                }
                self.special = false;
                self.section = end_of_text as isize + 2;
                self.in_closing_tag_name(c);
                return;
            }
            self.matched = 0;
        }
        if (c | 0x20) == self.sequence[self.matched] {
            self.matched += 1;
        } else if self.matched == 0 {
            if self.sequence == TITLE_END || self.sequence == TEXTAREA_END {
                if c == b'&' {
                    self.entity(false);
                }
            } else if self.fast_forward_to(b'<') {
                self.matched = 1;
            }
        } else {
            self.matched = usize::from(c == b'<');
        }
    }

    fn before_tag_name(&mut self, c: u8) {
        if c == b'!' {
            self.state = State::BeforeDeclaration;
            self.section = self.index as isize + 1;
        } else if c == b'?' {
            self.state = State::InSpecialComment;
            self.section = self.index as isize;
        } else if c.is_ascii_alphabetic() {
            self.section = self.index as isize;
            let special = match self.context() {
                Context::Html => special_sequence(c | 0x20),
                _ => None,
            };
            match special {
                Some(sequence) => {
                    self.special = true;
                    self.sequence = sequence;
                    self.matched = 3;
                    self.state = State::SpecialStartSequence;
                }
                None => self.state = State::InTagName,
            }
        } else if c == b'/' {
            self.state = State::BeforeClosingTagName;
        } else {
            self.state = State::Text;
            self.in_text(c);
        }
    }

    fn in_tag_name(&mut self, c: u8) {
        if ends_tag_section(c) {
            let name = self.read_tag_name(self.section, self.index);
            self.open_tag_name(name);
            self.section = -1;
            self.state = State::BeforeAttributeName;
            self.before_attribute_name(c);
        }
    }

    fn before_closing_tag_name(&mut self, c: u8) {
        if c == b'>' {
            self.resume_text();
            return;
        }
        self.state = if c.is_ascii_alphabetic() {
            State::InClosingTagName
        } else {
            State::InSpecialComment
        };
        self.section = self.index as isize;
    }

    fn in_closing_tag_name(&mut self, c: u8) {
        if ends_tag_section(c) {
            self.closing_tag(self.section, self.index);
            self.section = -1;
            self.state = State::AfterClosingTagName;
            self.skip_to_gt(c);
        }
    }

    fn skip_to_gt(&mut self, c: u8) {
        if c == b'>' || self.fast_forward_to(b'>') {
            self.resume_text();
        }
    }

    fn before_attribute_name(&mut self, c: u8) {
        if c == b'>' {
            self.end_open_tag();
            self.enter_tag_body();
            self.section = self.index as isize + 1;
        } else if c == b'/' {
            self.state = State::InSelfClosingTag;
        } else if !is_ws(c) {
            self.state = State::InAttributeName;
            self.section = self.index as isize;
        }
    }

    fn in_self_closing_tag(&mut self, c: u8) {
        if c == b'>' {
            if self.context() == Context::Html {
                self.end_open_tag();
            } else {
                self.close_current_tag();
            }
            self.section = self.index as isize + 1;
            self.enter_tag_body();
        } else if !is_ws(c) {
            self.state = State::BeforeAttributeName;
            self.before_attribute_name(c);
        }
    }

    fn in_attribute_name(&mut self, c: u8) {
        if c == b'=' || ends_tag_section(c) {
            self.attribute_name = lowercase(self.slice(self.section, self.index));
            self.section = self.index as isize;
            self.state = State::AfterAttributeName;
            self.after_attribute_name(c);
        }
    }

    fn after_attribute_name(&mut self, c: u8) {
        if c == b'=' {
            self.state = State::BeforeAttributeValue;
        } else if c == b'/' || c == b'>' {
            self.attribute_end();
            self.section = -1;
            self.state = State::BeforeAttributeName;
            self.before_attribute_name(c);
        } else if !is_ws(c) {
            self.attribute_end();
            self.state = State::InAttributeName;
            self.section = self.index as isize;
        }
    }

    fn before_attribute_value(&mut self, c: u8) {
        if c == b'"' || c == b'\'' {
            self.state = if c == b'"' {
                State::InValueDq
            } else {
                State::InValueSq
            };
            self.section = self.index as isize + 1;
        } else if !is_ws(c) {
            self.section = self.index as isize;
            self.state = State::InValueNq;
            self.in_unquoted_value(c);
        }
    }

    fn in_quoted_value(&mut self, c: u8, quote: u8) {
        if c == quote {
            self.attribute_data(self.section, self.index);
            self.section = -1;
            self.attribute_end();
            self.state = State::BeforeAttributeName;
        } else if c == b'&' {
            self.entity(true);
        } else {
            self.skip_before(memchr::memchr2(quote, b'&', &self.bytes[self.index..]));
        }
    }

    fn in_unquoted_value(&mut self, c: u8) {
        if is_ws(c) || c == b'>' {
            self.attribute_data(self.section, self.index);
            self.section = -1;
            self.attribute_end();
            self.state = State::BeforeAttributeName;
            self.before_attribute_name(c);
        } else if c == b'&' {
            self.entity(true);
        }
    }

    fn before_declaration(&mut self, c: u8) {
        if c == b'[' {
            self.state = State::CdataSequence;
            self.matched = 0;
        } else if (c | 0x20) == b'd' {
            self.state = State::DeclarationSequence;
            self.sequence = DOCTYPE;
            self.matched = 1;
        } else {
            self.before_comment(c);
        }
    }

    fn declaration_sequence(&mut self, c: u8) {
        if self.matched == self.sequence.len() {
            self.state = State::InDeclaration;
            self.skip_to_gt(c);
        } else if (c | 0x20) == self.sequence[self.matched] {
            self.matched += 1;
        } else if c == b'>' {
            self.resume_text();
        } else {
            self.state = State::InSpecialComment;
        }
    }

    fn before_comment(&mut self, c: u8) {
        if c == b'-' && self.state == State::BeforeDeclaration {
            self.state = State::BeforeComment;
        } else if c == b'-' {
            self.state = State::InCommentLike;
            self.sequence = COMMENT_END;
            self.matched = 0;
            self.section = self.index as isize + 1;
        } else if c == b'>' {
            self.resume_text();
        } else {
            self.state = State::InSpecialComment;
        }
    }

    fn context(&self) -> Context {
        self.contexts.last().copied().unwrap_or(Context::Html)
    }

    fn read_tag_name(&self, start: isize, end: usize) -> Vec<u8> {
        let name = lowercase(self.slice(start, end));
        if self.contexts.len() > 1 {
            let svg = SVG_NAMES
                .iter()
                .map(|svg| svg.as_bytes())
                .find(|svg| svg.eq_ignore_ascii_case(&name));
            if let Some(svg) = svg
                .filter(|svg| self.context() == Context::Svg || self.stack.iter().any(|s| s == svg))
            {
                return svg.to_vec();
            }
        }
        if self.context() == Context::Html && name == b"image" {
            return b"img".to_vec();
        }
        name
    }

    fn open_tag_name(&mut self, name: Vec<u8>) {
        if name == b"form" && self.stack.iter().any(|s| s == b"form") {
            self.tag_name = Vec::new();
            return;
        }
        let closes = implies_close(&name);
        while self
            .stack
            .last()
            .is_some_and(|top| closes.contains(&top.as_slice()))
        {
            self.pop_element();
        }
        if !is_void(&name) {
            match name.as_slice() {
                b"svg" => self.contexts.push(Context::Svg),
                b"math" => self.contexts.push(Context::Math),
                other if is_integration(other) => self.contexts.push(Context::Html),
                _ => {}
            }
            self.stack.push(name.clone());
        }
        self.tag_name = name;
        self.attributes = Some(Vec::new());
    }

    fn end_open_tag(&mut self) {
        let name = std::mem::take(&mut self.tag_name);
        if let Some(attributes) = self.attributes.take() {
            self.open_tag(&name, attributes);
        }
        if is_void(&name) {
            self.close_tag(&name);
        }
    }

    fn close_current_tag(&mut self) {
        let name = self.tag_name.clone();
        self.end_open_tag();
        if self.stack.last() == Some(&name) {
            self.pop_element();
        }
    }

    fn closing_tag(&mut self, start: isize, end: usize) {
        let name = self.read_tag_name(start, end);
        if is_void(&name) {
            if name == b"br" {
                self.open_tag(b"br", Vec::new());
                self.close_tag(b"br");
            }
        } else if let Some(at) = self.stack.iter().rposition(|s| *s == name) {
            for _ in at..self.stack.len() {
                self.pop_element();
            }
        } else if name == b"p" {
            self.open_tag_name(name);
            self.close_current_tag();
        }
    }

    fn pop_element(&mut self) {
        let Some(name) = self.stack.pop() else { return };
        if matches!(name.as_slice(), b"math" | b"svg") || is_integration(&name) {
            self.contexts.pop();
        }
        self.close_tag(&name);
    }

    fn attribute_data(&mut self, start: isize, end: usize) {
        let data = self.slice(start, end);
        self.attribute_value.extend_from_slice(data);
    }

    fn attribute_end(&mut self) {
        let value = std::mem::take(&mut self.attribute_value);
        if let Some(attributes) = &mut self.attributes
            && !attributes
                .iter()
                .any(|(name, _)| *name == self.attribute_name)
        {
            attributes.push((self.attribute_name.clone(), value));
        }
    }

    /// Text from `start` to `end`. A start of -1 is htmlparser2 slicing from -1: the last UTF-16
    /// code unit, which is half a surrogate pair when the input ends in an astral character.
    fn text_between(&mut self, start: isize, end: usize) {
        if start >= 0 {
            let text = self.slice(start, end);
            self.on_text(text);
            return;
        }
        let Some((cp, length)) = code_points(&self.bytes[..end]).last() else {
            return;
        };
        let mut last = Vec::new();
        match cp {
            0x1_0000.. => push_code_point(&mut last, 0xdc00 | (cp - 0x1_0000) & 0x3ff),
            _ => last.extend_from_slice(&self.bytes[end - length..end]),
        }
        self.on_text(&last);
    }

    fn on_text(&mut self, text: &[u8]) {
        if self.skip_text > 0 {
            return;
        }
        match self.frames.last() {
            Some((tag, _)) if tag == b"iframe" && self.iframe_depth < 8 => {
                let fallback = sanitize(text, self.iframe_depth + 1);
                self.out.extend_from_slice(&fallback);
            }
            _ => escape_into(&mut self.out, text, false),
        }
    }

    fn open_tag(&mut self, name: &[u8], attributes: Attributes) {
        if self.skip_text > 0 {
            self.skip_text += 1;
            return;
        }
        let allowed = is_allowed(name);
        self.frames.push((name.to_vec(), !allowed));
        if !allowed {
            if is_non_text(name) {
                self.skip_text = 1;
            }
            return;
        }
        self.out.push(b'<');
        self.out.extend_from_slice(name);
        self.write_attributes(name, attributes);
        let end: &[u8] = if is_self_closing(name) { b" />" } else { b">" };
        self.out.extend_from_slice(end);
    }

    fn write_attributes(&mut self, name: &[u8], parsed: Attributes) {
        let allowed: &[&[u8]] = match name {
            b"a" => &[b"href", b"name", b"target", b"rel"],
            b"audio" => &[b"controls", b"src"],
            b"img" => &[
                b"alt",
                b"decoding",
                b"height",
                b"loading",
                b"sizes",
                b"src",
                b"srcset",
                b"title",
                b"width",
            ],
            b"source" => &[b"sizes", b"src", b"srcset", b"type"],
            b"video" => &[b"controls", b"height", b"poster", b"src", b"width"],
            _ => return,
        };
        let mut attributes = match name {
            b"img" => vec![
                (b"decoding".to_vec(), b"async".to_vec()),
                (b"loading".to_vec(), b"lazy".to_vec()),
            ],
            _ => Vec::new(),
        };
        for (key, value) in parsed {
            set_attribute(&mut attributes, &key, value);
        }
        if name == b"a" {
            set_attribute(&mut attributes, b"rel", b"noopener noreferrer".to_vec());
        }
        for (key, mut value) in attributes {
            if !allowed.contains(&key.as_slice())
                || (value.is_empty() && key != b"alt" && key != b"controls")
                || (matches!(key.as_slice(), b"href" | b"src" | b"poster") && naughty(&value))
            {
                continue;
            }
            if key == b"srcset" {
                let Some(srcset) = sanitize_srcset(&value) else {
                    continue;
                };
                value = srcset;
            }
            self.out.push(b' ');
            self.out.extend_from_slice(&key);
            if !value.is_empty() || key == b"alt" {
                self.out.extend_from_slice(b"=\"");
                escape_into(&mut self.out, &value, true);
                self.out.push(b'"');
            }
        }
    }

    fn close_tag(&mut self, name: &[u8]) {
        if self.skip_text > 0 {
            self.skip_text -= 1;
            if self.skip_text > 0 {
                return;
            }
        }
        let Some((tag, skipped)) = self.frames.pop() else {
            return;
        };
        if tag != name {
            self.frames.push((tag, skipped));
            return;
        }
        if !skipped && !is_self_closing(name) {
            self.out.extend_from_slice(b"</");
            self.out.extend_from_slice(name);
            self.out.push(b'>');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(html: &str) -> String {
        String::from_utf16_lossy(
            &extract_article(Some(html.encode_utf16().collect())).unwrap_or_default(),
        )
    }

    #[test]
    fn keeps_htmlparser2_end_of_input_quirks() {
        assert_eq!(run("</b foo"), "o");
        assert_eq!(run("<b/"), "/");
        assert_eq!(run("a<"), "a&lt;");
        assert_eq!(run("x</b"), "x");
        assert_eq!(run("<!--x"), "");
    }

    #[test]
    fn resanitizes_iframe_text_chunk_by_chunk() {
        assert_eq!(run("<iframe>&amp;lt;</iframe>"), "&amp;lt;");
        assert_eq!(
            run("<p>a<svg><iframe>&amp;lt;</iframe></svg>"),
            "<p>a&amp;lt;</p>"
        );
    }

    #[test]
    fn transforms_links_and_images() {
        assert_eq!(
            run("<a href=x rel=me onclick=y>l</a>"),
            "<a href=\"x\" rel=\"noopener noreferrer\">l</a>"
        );
        assert_eq!(
            run("<image src=x>"),
            "<img decoding=\"async\" loading=\"lazy\" src=\"x\" />"
        );
        assert_eq!(
            run("<a href='java\tscript:x'>q</a>"),
            "<a rel=\"noopener noreferrer\">q</a>"
        );
    }

    #[test]
    fn formats_srcset_numbers_like_javascript() {
        assert_eq!(
            sanitize_srcset(b"a.png 99999999999999999999w, b 1e21w, c 1e-7x").as_deref(),
            Some(&b"a.png 100000000000000000000w, c 1e-7x"[..])
        );
        assert_eq!(sanitize_srcset(b"javascript:x 1x"), None);
    }

    #[test]
    fn decodes_entities_by_context() {
        assert_eq!(run("&notit; &amp=&ampx"), "¬it; &amp;=&amp;x");
        assert_eq!(
            run("<a name='&notit;&amp=&ampx'>q</a>"),
            "<a name=\"&amp;notit;&amp;amp=&amp;ampx\" rel=\"noopener noreferrer\">q</a>"
        );
        assert_eq!(run("&#0;&#128;&#x110000;"), "\u{fffd}\u{20ac}\u{fffd}");
    }

    #[test]
    fn keeps_lone_surrogates_like_js_strings() {
        let units = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
        assert_eq!(extract_article(Some(units("</b foo😀"))), Ok(vec![0xde00]));
        let mut lone = units("a");
        lone.extend([0xd800, u16::from(b'<')]);
        let mut escaped = units("a");
        escaped.push(0xd800);
        escaped.extend(units("&lt;"));
        assert_eq!(extract_article(Some(lone)), Ok(escaped));
    }

    #[test]
    fn implied_closes_follow_htmlparser2() {
        assert_eq!(run("<p>a<div>b</div>c"), "<p>a</p><div>b</div>c");
        assert_eq!(run("</p>"), "<p></p>");
        assert_eq!(run("<script>x</script>ok<option>y</option>"), "ok");
    }
}
