//! Bounded S-expression reader. Strings and escaping are parsed independently of syntax.
use crate::project::error::{ProjectError, ProjectResult};
#[derive(Clone, Debug)]
pub enum Expr {
    Atom(String),
    Text(String),
    List(Vec<Expr>),
}
impl Expr {
    pub fn atom(&self) -> &str {
        match self {
            Self::Atom(v) | Self::Text(v) => v,
            _ => "",
        }
    }
    pub fn list(&self) -> &[Expr] {
        match self {
            Self::List(v) => v,
            _ => &[],
        }
    }
    pub fn tag(&self) -> &str {
        self.list().first().map_or("", Expr::atom)
    }
    pub fn child(&self, key: &str) -> Option<&Expr> {
        self.list().iter().find(|e| e.tag() == key)
    }
    pub fn val(&self, i: usize) -> &str {
        self.list().get(i).map_or("", Expr::atom)
    }
    pub fn num(&self, i: usize) -> f64 {
        self.val(i).parse().unwrap_or(0.)
    }
}
pub fn error(message: &str) -> ProjectError {
    ProjectError::new("unsupported_library", message)
}
pub fn parse(text: &str) -> ProjectResult<Expr> {
    if text.len() > 64 * 1024 * 1024 {
        return Err(error("Library file exceeds 64 MiB."));
    }
    let b = text.as_bytes();
    let mut pos = 0;
    let mut count = 0;
    fn read(b: &[u8], p: &mut usize, depth: usize, count: &mut usize) -> ProjectResult<Expr> {
        *count += 1;
        if depth > 128 || *count > 2_000_000 {
            return Err(error("Library complexity limit exceeded."));
        }
        skip(b, p);
        if *p >= b.len() {
            return Err(error("Unexpected end of library."));
        }
        if b[*p] == b'(' {
            *p += 1;
            let mut items = vec![];
            loop {
                skip(b, p);
                if *p >= b.len() {
                    return Err(error("Unclosed expression."));
                }
                if b[*p] == b')' {
                    *p += 1;
                    break;
                }
                items.push(read(b, p, depth + 1, count)?);
            }
            Ok(Expr::List(items))
        } else if b[*p] == b'"' {
            *p += 1;
            let mut out = vec![];
            while *p < b.len() {
                let c = b[*p];
                *p += 1;
                if c == b'"' {
                    return String::from_utf8(out)
                        .map(Expr::Text)
                        .map_err(|_| error("Invalid UTF-8."));
                }
                if c == b'\\' {
                    if *p >= b.len() {
                        break;
                    }
                    let c = b[*p];
                    *p += 1;
                    out.push(match c {
                        b'n' => b'\n',
                        b't' => b'\t',
                        _ => c,
                    });
                } else {
                    out.push(c);
                }
            }
            Err(error("Unclosed string."))
        } else {
            let start = *p;
            while *p < b.len() && !b[*p].is_ascii_whitespace() && b[*p] != b'(' && b[*p] != b')' {
                *p += 1;
            }
            if *p == start {
                return Err(error("Unexpected closing expression."));
            }
            String::from_utf8(b[start..*p].to_vec())
                .map(Expr::Atom)
                .map_err(|_| error("Invalid UTF-8."))
        }
    }
    fn skip(b: &[u8], p: &mut usize) {
        loop {
            while *p < b.len() && b[*p].is_ascii_whitespace() {
                *p += 1;
            }
            if *p < b.len() && b[*p] == b';' {
                while *p < b.len() && b[*p] != b'\n' {
                    *p += 1;
                }
            } else {
                break;
            }
        }
    }
    let expr = read(b, &mut pos, 0, &mut count)?;
    skip(b, &mut pos);
    if pos != b.len() {
        return Err(error("Trailing library content."));
    }
    Ok(expr)
}
pub fn print(e: &Expr) -> String {
    match e {
        Expr::Atom(s) => s.clone(),
        Expr::Text(s) => format!(
            "\"{}\"",
            s.replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n")
        ),
        Expr::List(items) => format!(
            "({})",
            items.iter().map(print).collect::<Vec<_>>().join(" ")
        ),
    }
}
