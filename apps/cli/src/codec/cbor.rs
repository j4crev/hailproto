use crate::contract::Error;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Text(String),
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    Map(Vec<(Value, Value)>),
    Tag(u64, Box<Value>),
}

impl Value {
    pub fn field(&self, name: &str) -> &Self {
        if let Self::Map(entries) = self
            && let Some((_, value)) = entries
                .iter()
                .find(|(key, _)| matches!(key,Self::Text(s) if s == name))
        {
            return value;
        }
        &Self::Null
    }
    pub fn text(&self) -> Result<&str, Error> {
        if let Self::Text(s) = self {
            Ok(s)
        } else {
            Err(invalid())
        }
    }
    pub fn bytes(&self) -> Result<&[u8], Error> {
        if let Self::Bytes(s) = self {
            Ok(s)
        } else {
            Err(invalid())
        }
    }
    pub fn array(&self) -> Result<&[Self], Error> {
        if let Self::Array(s) = self {
            Ok(s)
        } else {
            Err(invalid())
        }
    }
    pub fn uint(&self, minimum: i64) -> Result<i64, Error> {
        if let Self::Int(n) = self
            && *n >= minimum
        {
            return Ok(*n);
        }
        Err(invalid())
    }
    pub fn diagnostic(&self) -> serde_json::Value {
        use base64::Engine;
        match self {
            Self::Null => serde_json::Value::Null,
            Self::Bool(v) => (*v).into(),
            Self::Int(v) => (*v).into(),
            Self::Text(v) => v.clone().into(),
            Self::Bytes(v) => base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(v)
                .into(),
            Self::Array(v) => v.iter().map(Self::diagnostic).collect(),
            Self::Map(v) => v
                .iter()
                .filter_map(|(k, v)| {
                    if let Self::Text(k) = k {
                        Some((
                            k.clone(),
                            if k == "token" {
                                "[REDACTED]".into()
                            } else {
                                v.diagnostic()
                            },
                        ))
                    } else {
                        None
                    }
                })
                .collect(),
            Self::Tag(_, _) => unreachable!("diagnostics only accept validated Hail payloads"),
        }
    }
}

pub fn invalid() -> Error {
    Error::client("Invalid signed Hail object")
}

#[derive(Clone, Copy)]
pub struct Limits {
    pub bytes: usize,
    depth: usize,
    items: usize,
    array: usize,
    map: usize,
    text: usize,
    pub(super) string: usize,
    cose: bool,
}
impl Limits {
    pub fn payload(bytes: usize) -> Self {
        Self {
            bytes,
            depth: 32,
            items: 16_384,
            array: 4096,
            map: 256,
            text: 262_144,
            string: 262_144,
            cose: false,
        }
    }
    pub fn cose(bytes: usize) -> Self {
        Self {
            bytes,
            depth: 8,
            items: 256,
            array: 8,
            map: 8,
            text: 1024,
            string: bytes,
            cose: true,
        }
    }
}

// Parse with budgets before allocation. Comparing raw key encodings enforces RFC
// 8949 bytewise ordering and rejects duplicate keys without normalizing input.
pub fn decode(bytes: &[u8], limits: Limits, tag18: bool) -> Result<Value, Error> {
    if bytes.len() > limits.bytes {
        return Err(invalid());
    }
    let mut parser = Parser {
        bytes,
        offset: 0,
        items: 0,
        limits,
        tag18,
    };
    let value = parser.value(0)?;
    if parser.offset != bytes.len() {
        return Err(invalid());
    }
    Ok(value)
}
struct Parser<'a> {
    bytes: &'a [u8],
    offset: usize,
    items: usize,
    limits: Limits,
    tag18: bool,
}
impl<'a> Parser<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], Error> {
        let end = self.offset.checked_add(count).ok_or_else(invalid)?;
        let result = self.bytes.get(self.offset..end).ok_or_else(invalid)?;
        self.offset = end;
        Ok(result)
    }
    fn argument(&mut self, info: u8) -> Result<u64, Error> {
        if info < 24 {
            return Ok(info.into());
        }
        let count = match info {
            24 => 1,
            25 => 2,
            26 => 4,
            27 => 8,
            _ => return Err(invalid()),
        };
        let value = self
            .take(count)?
            .iter()
            .fold(0u64, |n, b| (n << 8) | u64::from(*b));
        let minimum = match count {
            1 => 24,
            2 => 256,
            4 => 65536,
            _ => 4294967296,
        };
        if value < minimum || value > 9_007_199_254_740_991 {
            return Err(invalid());
        }
        Ok(value)
    }
    fn value(&mut self, depth: usize) -> Result<Value, Error> {
        self.items += 1;
        if depth > self.limits.depth || self.items > self.limits.items {
            return Err(invalid());
        }
        let initial = self.take(1)?[0];
        let major = initial >> 5;
        if major == 7 {
            return match initial {
                0xf4 => Ok(Value::Bool(false)),
                0xf5 => Ok(Value::Bool(true)),
                0xf6 => Ok(Value::Null),
                _ => Err(invalid()),
            };
        }
        let argument = self.argument(initial & 31)?;
        if major == 0 {
            return Ok(Value::Int(argument as i64));
        }
        if major == 1 {
            if argument == 9_007_199_254_740_991 {
                return Err(invalid());
            }
            return Ok(Value::Int(-1 - argument as i64));
        }
        let length = usize::try_from(argument).map_err(|_| invalid())?;
        match major {
            2 if length <= self.limits.string => Ok(Value::Bytes(self.take(length)?.to_vec())),
            3 if length <= self.limits.text => Ok(Value::Text(
                std::str::from_utf8(self.take(length)?)
                    .map_err(|_| invalid())?
                    .into(),
            )),
            4 if length <= self.limits.array => {
                let mut values = Vec::new();
                for _ in 0..length {
                    values.push(self.value(depth + 1)?);
                }
                Ok(Value::Array(values))
            }
            5 if length <= self.limits.map => {
                let mut entries = Vec::new();
                let mut previous: Option<&[u8]> = None;
                for _ in 0..length {
                    let start = self.offset;
                    let key = self.value(depth + 1)?;
                    if !matches!(key, Value::Text(_))
                        && !(self.limits.cose && matches!(key, Value::Int(_)))
                    {
                        return Err(invalid());
                    }
                    let encoded = &self.bytes[start..self.offset];
                    if previous.is_some_and(|p| p >= encoded) {
                        return Err(invalid());
                    }
                    previous = Some(encoded);
                    entries.push((key, self.value(depth + 1)?));
                }
                Ok(Value::Map(entries))
            }
            6 if self.tag18 && argument == 18 => {
                Ok(Value::Tag(18, Box::new(self.value(depth + 1)?)))
            }
            _ => Err(invalid()),
        }
    }
}

// Encode only values admitted by the same bounded decoder. Sorting encoded keys
// implements RFC 8949 ordering and also detects duplicate input keys.
pub fn encode(value: &Value, limits: Limits, tag18: bool) -> Result<Vec<u8>, Error> {
    fn head(out: &mut Vec<u8>, major: u8, n: u64) {
        let prefix = major << 5;
        match n {
            0..=23 => out.push(prefix | n as u8),
            24..=255 => out.extend_from_slice(&[prefix | 24, n as u8]),
            256..=65535 => {
                out.push(prefix | 25);
                out.extend_from_slice(&(n as u16).to_be_bytes());
            }
            65536..=4294967295 => {
                out.push(prefix | 26);
                out.extend_from_slice(&(n as u32).to_be_bytes());
            }
            _ => {
                out.push(prefix | 27);
                out.extend_from_slice(&n.to_be_bytes());
            }
        }
    }
    fn write(
        value: &Value,
        out: &mut Vec<u8>,
        depth: usize,
        items: &mut usize,
        limits: Limits,
    ) -> Result<(), Error> {
        *items += 1;
        if depth > limits.depth || *items > limits.items || out.len() > limits.bytes {
            return Err(invalid());
        }
        match value {
            Value::Null => out.push(0xf6),
            Value::Bool(v) => out.push(if *v { 0xf5 } else { 0xf4 }),
            Value::Int(n) => {
                if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(n) {
                    return Err(invalid());
                }
                head(
                    out,
                    if *n < 0 { 1 } else { 0 },
                    if *n < 0 { (-1 - *n) as u64 } else { *n as u64 },
                );
            }
            Value::Text(s) => {
                if s.len() > limits.text {
                    return Err(invalid());
                }
                head(out, 3, s.len() as u64);
                out.extend_from_slice(s.as_bytes());
            }
            Value::Bytes(b) => {
                if b.len() > limits.string {
                    return Err(invalid());
                }
                head(out, 2, b.len() as u64);
                out.extend_from_slice(b);
            }
            Value::Array(a) => {
                if a.len() > limits.array {
                    return Err(invalid());
                }
                head(out, 4, a.len() as u64);
                for v in a {
                    write(v, out, depth + 1, items, limits)?;
                }
            }
            Value::Map(m) => {
                if m.len() > limits.map {
                    return Err(invalid());
                }
                let mut entries = Vec::new();
                for (key, value) in m {
                    if !matches!(key, Value::Text(_))
                        && !(limits.cose && matches!(key, Value::Int(_)))
                    {
                        return Err(invalid());
                    }
                    let mut encoded = Vec::new();
                    write(key, &mut encoded, depth + 1, items, limits)?;
                    entries.push((encoded, value));
                }
                entries.sort_by(|a, b| a.0.cmp(&b.0));
                if entries.windows(2).any(|w| w[0].0 == w[1].0) {
                    return Err(invalid());
                }
                head(out, 5, entries.len() as u64);
                for (key, value) in entries {
                    out.extend_from_slice(&key);
                    write(value, out, depth + 1, items, limits)?;
                }
            }
            Value::Tag(tag, v) => {
                head(out, 6, *tag);
                write(v, out, depth + 1, items, limits)?;
            }
        }
        if out.len() > limits.bytes {
            return Err(invalid());
        }
        Ok(())
    }
    let mut out = Vec::new();
    write(value, &mut out, 0, &mut 0, limits)?;
    decode(&out, limits, tag18)?;
    Ok(out)
}

pub fn from_json(value: &serde_json::Value) -> Result<Value, Error> {
    fn convert(value: &serde_json::Value, depth: usize, items: &mut usize) -> Result<Value, Error> {
        *items += 1;
        if depth > 32 || *items > 16384 {
            return Err(invalid());
        }
        Ok(match value {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(v) => Value::Bool(*v),
            serde_json::Value::Number(v) => Value::Int(
                v.as_i64()
                    .or_else(|| {
                        v.as_f64()
                            .filter(|n| {
                                n.is_finite()
                                    && !(*n == 0.0 && n.is_sign_negative())
                                    && n.fract() == 0.0
                                    && n.abs() <= 9_007_199_254_740_991.0
                            })
                            .map(|n| n as i64)
                    })
                    .ok_or_else(invalid)?,
            ),
            serde_json::Value::String(v) => Value::Text(v.clone()),
            serde_json::Value::Array(v) => Value::Array(
                v.iter()
                    .map(|v| convert(v, depth + 1, items))
                    .collect::<Result<_, _>>()?,
            ),
            serde_json::Value::Object(v) => Value::Map(
                v.iter()
                    .map(|(k, v)| Ok((Value::Text(k.clone()), convert(v, depth + 1, items)?)))
                    .collect::<Result<_, Error>>()?,
            ),
        })
    }
    let result = convert(value, 0, &mut 0)?;
    encode(&result, Limits::payload(262144), false)?;
    Ok(result)
}
