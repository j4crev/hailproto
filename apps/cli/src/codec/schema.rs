use super::cbor::{Value as V, invalid};
use crate::contract::{DID, Error, ID};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

static CATEGORY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9._-]{0,63}$").unwrap());
static LOCAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$").unwrap()
});
static LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$").unwrap());
static ASSET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9-]{0,63}$").unwrap());

fn ensure(ok: bool) -> Result<(), Error> {
    if ok { Ok(()) } else { Err(invalid()) }
}
fn exact(value: &V, required: &[&str], optional: &[&str]) -> Result<(), Error> {
    let V::Map(entries) = value else {
        return Err(invalid());
    };
    let keys = entries
        .iter()
        .map(|(k, _)| k.text())
        .collect::<Result<Vec<_>, _>>()?;
    ensure(
        required.iter().all(|k| keys.contains(k))
            && keys
                .iter()
                .all(|k| required.contains(k) || optional.contains(k)),
    )
}
fn text(value: &V, max: usize) -> Result<(), Error> {
    use unicode_general_category::{GeneralCategory, get_general_category};
    let text = value.text()?;
    ensure(
        !text.is_empty()
            && text.len() <= max
            && text.nfc().eq(text.chars())
            && !text.chars().any(|c| {
                matches!(
                    get_general_category(c),
                    GeneralCategory::Control | GeneralCategory::Format
                )
            }),
    )
}
fn address(value: &V) -> Result<(), Error> {
    use idna::uts46::{AsciiDenyList, DnsLength, Hyphens, Uts46};
    let address = value.text()?;
    let (local, domain) = address.rsplit_once('@').ok_or_else(invalid)?;
    ensure(
        address.len() <= 254
            && local.len() <= 63
            && LOCAL.is_match(local)
            && !domain.is_empty()
            && domain.len() <= 253
            && domain.contains('.')
            && domain.split('.').all(|s| LABEL.is_match(s)),
    )?;
    let ascii = Uts46::new()
        .to_ascii(
            domain.as_bytes(),
            AsciiDenyList::STD3,
            Hyphens::Check,
            DnsLength::Verify,
        )
        .map_err(|_| invalid())?;
    ensure(ascii == domain && psl::domain(domain.as_bytes()).is_some_and(|d| d.suffix().is_known()))
}
fn hash(value: &V) -> Result<(), Error> {
    exact(value, &["algorithm", "value"], &[])?;
    ensure(
        value.field("algorithm").text()? == "sha-256" && value.field("value").bytes()?.len() == 32,
    )
}
fn did(value: &V) -> Result<(), Error> {
    ensure(DID.is_match(value.text()?))
}
fn key(value: &V, signer: &str, role: &str) -> Result<(), Error> {
    ensure(value.text()? == format!("{signer}#{role}"))
}

pub fn validate(kind: &str, p: &V) -> Result<(), Error> {
    ensure(p.field("type").text()? == kind)?;
    match kind {
        "hail.sender-profile" => profile(p),
        "hail.address-binding" => {
            exact(
                p,
                &[
                    "version",
                    "type",
                    "address",
                    "did",
                    "issued_at",
                    "expires_at",
                    "key_id",
                ],
                &[],
            )?;
            ensure(p.field("version").uint(1)? == 1)?;
            did(p.field("did"))?;
            address(p.field("address"))?;
            let issued = p.field("issued_at").uint(0)?;
            let expiry = p.field("expires_at").uint(0)?;
            ensure(expiry > issued && expiry - issued <= 7_776_000)?;
            key(p.field("key_id"), p.field("did").text()?, "hail-identity")
        }
        "hail.grant" => grant(p),
        "hail.connection-invitation" | "hail.connection-confirmation" => connection(kind, p),
        _ => Err(invalid()),
    }
}
fn profile(p: &V) -> Result<(), Error> {
    let version = p.field("version").uint(1)?;
    ensure(version == 1 || version == 2)?;
    exact(
        p,
        &[
            "type",
            "version",
            "did",
            "revision",
            "display_name",
            "offers_uncategorized",
            "categories",
            "updated_at",
            "key_id",
        ],
        if version == 1 {
            &["description"]
        } else {
            &["description", "assets"]
        },
    )?;
    did(p.field("did"))?;
    p.field("revision").uint(1)?;
    p.field("updated_at").uint(0)?;
    text(p.field("display_name"), 128)?;
    if has(p, "description") {
        text(p.field("description"), 1024)?;
    }
    ensure(matches!(p.field("offers_uncategorized"), V::Bool(_)))?;
    let categories = p.field("categories").array()?;
    ensure(categories.len() <= 100)?;
    let mut previous = "";
    for item in categories {
        exact(item, &["id", "label"], &["description"])?;
        let id = item.field("id").text()?;
        ensure(CATEGORY.is_match(id) && id > previous)?;
        previous = id;
        text(item.field("label"), 128)?;
        if has(item, "description") {
            text(item.field("description"), 1024)?;
        }
    }
    if has(p, "assets") {
        avatar(p.field("assets"))?;
    }
    key(p.field("key_id"), p.field("did").text()?, "hail-messaging")
}
fn has(value: &V, name: &str) -> bool {
    matches!(value,V::Map(entries) if entries.iter().any(|(k,_)| matches!(k,V::Text(k) if k == name)))
}
fn grant(p: &V) -> Result<(), Error> {
    exact(
        p,
        &[
            "type",
            "version",
            "grant_id",
            "revision",
            "previous",
            "grantor",
            "grantee",
            "scope",
            "status",
            "issued_at",
            "updated_at",
            "expires_at",
            "consent_context",
            "key_id",
        ],
        &[],
    )?;
    ensure(p.field("version").uint(1)? == 1 && ID.is_match(p.field("grant_id").text()?))?;
    let revision = p.field("revision").uint(1)?;
    if revision == 1 {
        ensure(*p.field("previous") == V::Null)?;
    } else {
        ensure(p.field("previous").bytes()?.len() == 32)?;
    }
    did(p.field("grantor"))?;
    did(p.field("grantee"))?;
    let [selector] = p.field("scope").array()? else {
        return Err(invalid());
    };
    match selector.field("type").text()? {
        "categories" => {
            exact(selector, &["type", "values"], &[])?;
            let values = selector.field("values").array()?;
            ensure(!values.is_empty())?;
            let mut previous = "";
            for value in values {
                let value = value.text()?;
                ensure(CATEGORY.is_match(value) && value > previous)?;
                previous = value;
            }
        }
        "uncategorized" => exact(selector, &["type"], &[])?,
        _ => return Err(invalid()),
    }
    ensure(matches!(p.field("status").text()?, "active" | "revoked"))?;
    ensure(p.field("updated_at").uint(0)? >= p.field("issued_at").uint(0)?)?;
    if *p.field("expires_at") != V::Null {
        p.field("expires_at").uint(0)?;
    }
    let consent = p.field("consent_context");
    exact(
        consent,
        &[
            "grantee_address",
            "address_binding_hash",
            "sender_profile_hash",
        ],
        &[],
    )?;
    address(consent.field("grantee_address"))?;
    hash(consent.field("address_binding_hash"))?;
    hash(consent.field("sender_profile_hash"))?;
    key(
        p.field("key_id"),
        p.field("grantor").text()?,
        "hail-identity",
    )
}
fn avatar(manifest: &V) -> Result<(), Error> {
    exact(manifest, &["version", "assets"], &[])?;
    ensure(manifest.field("version").uint(1)? == 1)?;
    let [asset] = manifest.field("assets").array()? else {
        return Err(invalid());
    };
    exact(
        asset,
        &[
            "id",
            "role",
            "media_type",
            "loading",
            "size",
            "digest",
            "width",
            "height",
            "data",
        ],
        &[],
    )?;
    ensure(
        ASSET.is_match(asset.field("id").text()?)
            && asset.field("role").text()? == "avatar"
            && asset.field("media_type").text()? == "image/png"
            && asset.field("loading").text()? == "bundled",
    )?;
    let data = asset.field("data").bytes()?;
    ensure(data.len() <= 32_768 && asset.field("size").uint(1)? as usize == data.len())?;
    hash(asset.field("digest"))?;
    ensure(Sha256::digest(data).as_slice() == asset.field("digest").field("value").bytes()?)?;
    let (width, height) = png(data)?;
    ensure(
        width <= 512
            && height <= 512
            && asset.field("width").uint(1)? == i64::from(width)
            && asset.field("height").uint(1)? == i64::from(height),
    )
}

// Match the codec's structural PNG checks, without decompressing untrusted data.
fn png(data: &[u8]) -> Result<(u32, u32), Error> {
    ensure(data.len() >= 45 && data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]))?;
    let u32_at = |i| u32::from_be_bytes(data[i..i + 4].try_into().unwrap());
    let mut offset = 8;
    let (mut width, mut height) = (0, 0);
    let (mut header, mut image, mut end, mut palette, mut ended) =
        (false, false, false, false, false);
    while offset + 12 <= data.len() {
        let length = u32_at(offset) as usize;
        let next = offset
            .checked_add(12)
            .and_then(|o| o.checked_add(length))
            .ok_or_else(invalid)?;
        ensure(next <= data.len())?;
        let kind = &data[offset + 4..offset + 8];
        let mut crc = 0xffffffffu32;
        for byte in &data[offset + 4..offset + 8 + length] {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ if crc & 1 == 1 { 0xedb88320 } else { 0 };
            }
        }
        ensure(u32_at(offset + 8 + length) == crc ^ 0xffffffff && (header || kind == b"IHDR"))?;
        match kind {
            b"IHDR" => {
                ensure(!header && length == 13)?;
                header = true;
                width = u32_at(offset + 8);
                height = u32_at(offset + 12);
                let depth = data[offset + 16];
                let color = data[offset + 17];
                let valid = match color {
                    0 => [1, 2, 4, 8, 16].contains(&depth),
                    2 | 4 | 6 => [8, 16].contains(&depth),
                    3 => [1, 2, 4, 8].contains(&depth),
                    _ => false,
                };
                ensure(
                    valid
                        && data[offset + 18] == 0
                        && data[offset + 19] == 0
                        && data[offset + 20] <= 1,
                )?;
            }
            b"acTL" => return Err(invalid()),
            b"PLTE" => {
                ensure(
                    !image && !palette && length > 0 && length.is_multiple_of(3) && length <= 768,
                )?;
                palette = true;
            }
            b"IDAT" => {
                ensure(!ended)?;
                image = true;
            }
            b"IEND" => {
                ensure(length == 0 && next == data.len())?;
                end = true;
                break;
            }
            _ => {
                if image {
                    ended = true;
                }
                ensure(!kind[0].is_ascii_uppercase())?;
            }
        }
        offset = next;
    }
    ensure(
        header
            && image
            && end
            && width > 0
            && height > 0
            && (data[25] != 3 || palette)
            && (![0, 4].contains(&data[25]) || !palette),
    )?;
    Ok((width, height))
}

fn connection(kind: &str, p: &V) -> Result<(), Error> {
    let confirmation = kind == "hail.connection-confirmation";
    exact(
        p,
        if confirmation {
            &[
                "type",
                "version",
                "confirmation_id",
                "from",
                "to",
                "invitation_id",
                "invitation_hash",
                "issued_at",
                "expires_at",
                "key_id",
            ]
        } else {
            &[
                "type",
                "version",
                "invitation_id",
                "from",
                "token_hash",
                "issued_at",
                "expires_at",
                "key_id",
            ]
        },
        &[],
    )?;
    ensure(p.field("version").uint(1)? == 1 && ID.is_match(p.field("invitation_id").text()?))?;
    did(p.field("from"))?;
    if confirmation {
        ensure(ID.is_match(p.field("confirmation_id").text()?))?;
        did(p.field("to"))?;
        ensure(p.field("from") != p.field("to"))?;
        hash(p.field("invitation_hash"))?;
    } else {
        hash(p.field("token_hash"))?;
    }
    let issued = p.field("issued_at").uint(0)?;
    if *p.field("expires_at") == V::Null {
        ensure(!confirmation)?;
    } else {
        let expiry = p.field("expires_at").uint(0)?;
        ensure(expiry > issued && (!confirmation || expiry - issued <= 300))?;
    }
    key(p.field("key_id"), p.field("from").text()?, "hail-identity")
}
