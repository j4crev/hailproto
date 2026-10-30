use crate::{api::Client, contract::Error, private, signed_reads};
use serde_json::{Value, json};
fn invalid() -> Error {
    Error::client("Sender Profile definition has an invalid shape")
}
pub async fn save(client: &Client, path: &str, update: bool) -> Result<Value, Error> {
    let revision = if update {
        signed_reads::profile(client).await?["revision"].clone()
    } else {
        json!(0)
    };
    let definition: Value =
        serde_json::from_slice(&private::read(path, 65536)?).map_err(|_| invalid())?;
    let object = definition.as_object().ok_or_else(invalid)?;
    if object.keys().any(|k| {
        ![
            "version",
            "display_name",
            "description",
            "offers_uncategorized",
            "categories",
            "avatar",
        ]
        .contains(&k.as_str())
    }) || object
        .get("version")
        .is_some_and(|v| v.as_f64() != Some(1.0) && v.as_f64() != Some(2.0))
        || !definition["display_name"].is_string()
        || object.get("description").is_some_and(|v| !v.is_string())
        || !definition["offers_uncategorized"].is_boolean()
        || object.get("avatar").is_some_and(|v| {
            definition["version"].as_f64() != Some(2.0) || !v.is_null() && !v.is_string()
        })
        || !definition["categories"].as_array().is_some_and(|v| {
            v.iter().all(|c| {
                c.as_object().is_some_and(|c| {
                    c.keys()
                        .all(|k| ["id", "label", "description"].contains(&k.as_str()))
                        && c.get("id").is_some_and(Value::is_string)
                        && c.get("label").is_some_and(Value::is_string)
                        && c.get("description").is_none_or(Value::is_string)
                })
            })
        })
    {
        return Err(invalid());
    }
    signed_reads::profile_response(
        client
            .post(
                "/profile",
                &json!({"definition":definition,"expectedRevision":revision}),
            )
            .await?,
    )
}
