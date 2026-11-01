package hailcodec

// This consumer deliberately imports no server code. It uses the published schema,
// Go's crypto and the independent Go CBOR codec to read fixed exporter artifacts.
import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/big"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

func interopFile(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("../../spec/" + name)
	if err != nil {
		t.Fatal(err)
	}
	value, err := interopJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value.(map[string]any)
}

// Duplicate-key rejection precedes conversion to a map, including nested values.
func interopJSON(raw []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	var read func() (any, error)
	read = func() (any, error) {
		tok, e := d.Token()
		if e != nil {
			return nil, e
		}
		switch tok {
		case json.Delim('{'):
			m := map[string]any{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return nil, e
				}
				key := k.(string)
				if _, ok := m[key]; ok {
					return nil, fmt.Errorf("duplicate key %s", key)
				}
				v, e := read()
				if e != nil {
					return nil, e
				}
				m[key] = v
			}
			_, e = d.Token()
			return m, e
		case json.Delim('['):
			a := []any{}
			for d.More() {
				v, e := read()
				if e != nil {
					return nil, e
				}
				a = append(a, v)
			}
			_, e = d.Token()
			return a, e
		default:
			return tok, nil
		}
	}
	value, e := read()
	if e != nil {
		return nil, e
	}
	if _, e = d.Token(); e != io.EOF {
		return nil, fmt.Errorf("trailing JSON")
	}
	return value, nil
}
func interopCBOR(v any) any {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case []any:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = interopCBOR(v)
		}
		return a
	case map[string]any:
		m := map[string]any{}
		for k, v := range x {
			m[k] = interopCBOR(v)
		}
		return m
	default:
		return v
	}
}
func interopEncode(t *testing.T, v any) []byte {
	t.Helper()
	limits := DefaultResourceLimits()
	limits.MaximumBytes = 67108864
	limits.MaximumItems = 2000000
	limits.MaximumArrayLength = 100000
	limits.MaximumTextBytes = 16777216
	limits.MaximumByteStringLength = 1048576
	b, e := EncodeDeterministicWithLimits(interopCBOR(v), limits)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func interopHash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func interopB64(t *testing.T, s string) []byte {
	t.Helper()
	b, e := base64.RawURLEncoding.Strict().DecodeString(s)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func interopHex(t *testing.T, s string) []byte {
	t.Helper()
	b, e := hex.DecodeString(s)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func interopPG(t *testing.T, v any) []byte {
	t.Helper()
	s, ok := v.(string)
	if !ok || !strings.HasPrefix(s, `\x`) {
		t.Fatalf("invalid byte text: %v", v)
	}
	return interopHex(t, s[2:])
}

// Independent evaluator for the finite JSON Schema vocabulary used in this schema.
// Unknown keywords fail the test, rather than silently weakening conformance.
func historyShape(root, s map[string]any, v any) error {
	for key := range s {
		switch key {
		case "$schema", "$id", "$ref", "title", "description", "definitions", "oneOf", "anyOf", "type", "const", "required", "properties", "additionalProperties", "items", "minimum", "maximum", "pattern", "format", "x-reference-storage", "x-record-key", "enum", "minLength", "maxLength", "minItems", "maxItems":
		default:
			return fmt.Errorf("unsupported schema keyword %s", key)
		}
	}
	if r, ok := s["$ref"].(string); ok {
		return historyShape(root, root["definitions"].(map[string]any)[strings.TrimPrefix(r, "#/definitions/")].(map[string]any), v)
	}
	for _, union := range []string{"oneOf", "anyOf"} {
		if alternatives, ok := s[union].([]any); ok {
			n := 0
			for _, a := range alternatives {
				if historyShape(root, a.(map[string]any), v) == nil {
					n++
				}
			}
			if n == 0 || (union == "oneOf" && n != 1) {
				return fmt.Errorf("%s mismatch", union)
			}
		}
	}
	if choices, ok := s["enum"].([]any); ok {
		found := false
		for _, choice := range choices {
			if reflect.DeepEqual(choice, v) {
				found = true
			}
		}
		if !found {
			return fmt.Errorf("enum mismatch")
		}
	}
	if c, ok := s["const"]; ok && !reflect.DeepEqual(c, v) {
		return fmt.Errorf("constant mismatch")
	}
	if kind, ok := s["type"].(string); ok {
		switch kind {
		case "null":
			if v != nil {
				return fmt.Errorf("not null")
			}
		case "boolean":
			if _, ok := v.(bool); !ok {
				return fmt.Errorf("not boolean")
			}
		case "integer":
			n, ok := v.(float64)
			if !ok || math.Trunc(n) != n {
				return fmt.Errorf("not integer")
			}
			if lo, ok := s["minimum"].(float64); ok && n < lo {
				return fmt.Errorf("below minimum")
			}
			if hi, ok := s["maximum"].(float64); ok && n > hi {
				return fmt.Errorf("above maximum")
			}
		case "string":
			text, ok := v.(string)
			if lo, ok := s["minLength"].(float64); ok && len([]rune(text)) < int(lo) {
				return fmt.Errorf("short string")
			}
			if hi, ok := s["maxLength"].(float64); ok && len([]rune(text)) > int(hi) {
				return fmt.Errorf("long string")
			}
			if !ok {
				return fmt.Errorf("not string")
			}
			if p, ok := s["pattern"].(string); ok && !regexp.MustCompile(p).MatchString(text) {
				return fmt.Errorf("pattern mismatch")
			}
			if s["format"] == "date-time" {
				if _, e := time.Parse(time.RFC3339Nano, text); e != nil {
					return e
				}
			}
		case "array":
			a, ok := v.([]any)
			if lo, ok := s["minItems"].(float64); ok && len(a) < int(lo) {
				return fmt.Errorf("short array")
			}
			if hi, ok := s["maxItems"].(float64); ok && len(a) > int(hi) {
				return fmt.Errorf("long array")
			}
			if !ok {
				return fmt.Errorf("not array")
			}
			for _, x := range a {
				if e := historyShape(root, s["items"].(map[string]any), x); e != nil {
					return e
				}
			}
		case "object":
			m, ok := v.(map[string]any)
			if !ok {
				return fmt.Errorf("not object")
			}
			if req, ok := s["required"].([]any); ok {
				for _, k := range req {
					if _, ok := m[k.(string)]; !ok {
						return fmt.Errorf("missing %s", k)
					}
				}
			}
			props, _ := s["properties"].(map[string]any)
			for k, x := range m {
				if p, ok := props[k]; ok {
					if e := historyShape(root, p.(map[string]any), x); e != nil {
						return fmt.Errorf("%s: %w", k, e)
					}
				} else if s["additionalProperties"] == false {
					return fmt.Errorf("extra %s", k)
				} else if p, ok := s["additionalProperties"].(map[string]any); ok {
					if e := historyShape(root, p, x); e != nil {
						return e
					}
				}
			}
		default:
			return fmt.Errorf("unsupported type %s", kind)
		}
	}
	return nil
}
func historyCheckpoint(t *testing.T, h map[string]any) string {
	return interopHash(interopEncode(t, h))
}
func b64Hash(t *testing.T, v any) string {
	return base64.RawURLEncoding.EncodeToString(interopHex(t, historyCheckpoint(t, v.(map[string]any))))
}
func ownedHistory(m map[string]any) error {
	for _, domain := range []string{"connections", "conversations"} {
		h := m[domain].(map[string]any)
		for _, field := range []string{"accountId", "did", "sourceGeneration", "sourceServiceBase", "capturedAt"} {
			if h[field] != m[field] {
				return fmt.Errorf("checkpoint owner mismatch")
			}
		}
	}
	tables := m["tables"].(map[string]any)
	account := tables["provider_accounts"].([]any)
	if len(account) != 1 || account[0].(map[string]any)["id"] != m["accountId"] || account[0].(map[string]any)["did"] != m["did"] {
		return fmt.Errorf("account mismatch")
	}
	for name, rows := range tables {
		for _, item := range rows.([]any) {
			row := item.(map[string]any)
			for _, field := range []string{"account_id", "local_account_id", "sender_account_id"} {
				if owner, ok := row[field]; ok && owner != m["accountId"] {
					return fmt.Errorf("foreign account in %s", name)
				}
			}
		}
	}
	return nil
}

// Independent managed-history projection specified in account-history.md.
func managedHistoryDigest(t *testing.T, m map[string]any) string {
	t.Helper()
	tables := m["tables"].(map[string]any)
	rows := func(name string) []any { return tables[name].([]any) }
	digest := func(v any) string { return base64.RawURLEncoding.EncodeToString(interopPG(t, v)) }
	sha := func(v any) string {
		h := sha256.Sum256(interopPG(t, v))
		return base64.RawURLEncoding.EncodeToString(h[:])
	}
	blank := func(v any) any {
		if v == nil {
			return ""
		}
		return v
	}
	h := map[string]any{"type": "hail.managed-migration-history-checkpoint", "version": float64(1), "did": m["did"], "source_generation": m["sourceGeneration"], "connection_checkpoint_digest": m["connectionCheckpointDigest"], "conversation_checkpoint_digest": m["conversationCheckpointDigest"]}
	for _, name := range []string{"plc", "grants", "bindings", "authority", "authority_links"} {
		h[name] = []any{}
	}
	add := func(name string, v any) { h[name] = append(h[name].([]any), v) }
	for _, v := range rows("plc_operation_evidence") {
		r := v.(map[string]any)
		add("plc", map[string]any{"id": r["id"], "operation_cid": r["operation_cid"], "previous_cid": blank(r["previous_cid"]), "state": r["submission_state"], "dag_cbor_sha256": sha(r["dag_cbor"])})
	}
	for _, v := range rows("grant_revisions") {
		r := v.(map[string]any)
		publication, etag := any("none"), any("")
		for _, p := range rows("grant_publications") {
			p := p.(map[string]any)
			if p["grant_id"] == r["grant_id"] && p["revision"] == r["revision"] {
				publication = p["state"]
				etag = blank(p["acknowledged_etag"])
				break
			}
		}
		add("grants", map[string]any{"grant_id": r["grant_id"], "revision": r["revision"], "status": r["status"], "digest": digest(r["representation_digest"]), "signer": r["signing_public_key"], "publication": publication, "etag": etag})
	}
	for _, v := range rows("address_bindings") {
		r := v.(map[string]any)
		add("bindings", map[string]any{"id": r["id"], "digest": digest(r["representation_digest"]), "selected_at": blank(r["selected_at"]), "published_at": blank(r["published_at"])})
	}
	for _, v := range rows("public_plc_resolution_evidence") {
		r := v.(map[string]any)
		add("authority", map[string]any{"did": r["did"], "operation_cid": r["operation_cid"], "evidence_digest": digest(r["evidence_digest"]), "bundle_sha256": sha(r["bundle_bytes"])})
	}
	for _, name := range []string{"public_envelope_authority_evidence", "public_grant_authority_evidence", "public_signing_authority_evidence"} {
		for _, v := range rows(name) {
			r := v.(map[string]any)
			add("authority_links", map[string]any{"authority_did": r["authority_did"], "representation_digest": digest(r["representation_digest"]), "evidence_digest": digest(r["evidence_digest"])})
		}
	}
	return b64Hash(t, h)
}
func TestAccountHistoryInteroperability(t *testing.T) {
	schema := interopFile(t, "schemas/account-history-v7-v8.json")
	for _, kind := range []string{"portable", "managed"} {
		t.Run(kind, func(t *testing.T) {
			v := interopFile(t, "vectors/"+kind+"-history.json")
			raw := interopB64(t, v["manifestBase64"].(string))
			value, e := interopJSON(raw)
			if e != nil {
				t.Fatal(e)
			}
			m := value.(map[string]any)
			if e = historyShape(schema, schema, m); e != nil {
				t.Fatal(e)
			}
			if e = ownedHistory(m); e != nil {
				t.Fatal(e)
			}
			if interopHash(raw) != v["digestHex"] {
				t.Fatal("manifest digest")
			}
			prefix := fmt.Sprintf("hail-migration-snapshot-v%.0f\x00", m["version"])
			input := append([]byte(prefix), interopHex(t, v["digestHex"].(string))...)
			key := interopHex(t, v["publicKeyHex"].(string))
			sig := interopHex(t, v["signatureHex"].(string))
			if !ed25519.Verify(key, input, sig) {
				t.Fatal("snapshot signature")
			}
			mutated := append(append([]byte{}, raw...), 10)
			if interopHash(mutated) != v["jsonWhitespaceMutationDigestHex"] {
				t.Fatal("mutation digest")
			}
			if ed25519.Verify(key, append([]byte(prefix), interopHex(t, interopHash(mutated))...), sig) {
				t.Fatal("reserialized manifest accepted")
			}
			for _, domain := range []string{"connection", "conversation"} {
				if b64Hash(t, m[domain+"s"]) != m[domain+"CheckpointDigest"] {
					t.Fatal(domain + " checkpoint")
				}
			}
			if kind == "managed" && managedHistoryDigest(t, m) != m["historyCheckpointDigest"] {
				t.Fatal("managed history projection")
			}
			// Import into an in-memory collection graph without SQL or physical table IDs.
			restored := map[string][]any{}
			for name, rows := range m["tables"].(map[string]any) {
				restored[name] = rows.([]any)
			}
			if len(restored) == 0 {
				t.Fatal("empty history")
			}
			m["accountId"] = "01954144-8097-7a9d-a7a8-ffffffffffff"
			if ownedHistory(m) == nil {
				t.Fatal("foreign owner accepted")
			}
		})
	}
	for _, name := range []string{"connection-history", "conversation-creator", "conversation-renewed", "conversation-left"} {
		t.Run(name, func(t *testing.T) {
			v := interopFile(t, "vectors/"+name+".json")
			h := v["history"].(map[string]any)
			def := "conversation-history"
			if name == "connection-history" {
				def = name
			}
			if e := historyShape(schema, schema["definitions"].(map[string]any)[def].(map[string]any), h); e != nil {
				t.Fatal(e)
			}
			if historyCheckpoint(t, h) != v["digestHex"] {
				t.Fatal("checkpoint digest")
			}
			h["unexpected"] = true
			if e := historyShape(schema, schema["definitions"].(map[string]any)[def].(map[string]any), h); e == nil {
				t.Fatal("unknown checkpoint field")
			}
		})
	}
}
func diagnosticInterop(t *testing.T, v any) any {
	switch x := v.(type) {
	case map[string]any:
		if s, ok := x["$bytes"].(string); ok {
			return interopHex(t, s)
		}
		m := map[string]any{}
		for k, v := range x {
			m[k] = diagnosticInterop(t, v)
		}
		return m
	case []any:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = diagnosticInterop(t, v)
		}
		return a
	default:
		return interopCBOR(v)
	}
}
func TestTransferWireInteroperability(t *testing.T) {
	vectors := interopFile(t, "vectors/transfer-wire.json")
	for _, item := range vectors["records"].([]any) {
		v := item.(map[string]any)
		t.Run(v["id"].(string), func(t *testing.T) {
			payload := interopHex(t, v["payloadHex"].(string))
			encoded := interopEncode(t, diagnosticInterop(t, v["diagnostic"]))
			if !bytes.Equal(encoded, payload) {
				t.Fatal("independent encoding")
			}
			if interopHash(payload) != v["payloadDigestHex"] {
				t.Fatal("payload hash")
			}
			domain := v["type"].(string) + ".v1"
			if role, ok := v["role"].(string); ok {
				if strings.HasPrefix(role, "owner-") || role == "destination-cancelled" {
					domain = "hail.connection-transfer." + role + ".v1"
				} else {
					domain = "hail.connection-handover." + role + ".v1"
				}
			}
			input := append([]byte(domain+"\x00"), payload...)
			if hex.EncodeToString(input) != v["signingInputHex"] {
				t.Fatal("signature domain")
			}
			sig := interopHex(t, v["signatureHex"].(string))
			pub := interopHex(t, v["publicKeyHex"].(string))
			verify := func(input []byte) bool {
				if v["algorithm"] == "Ed25519" {
					return ed25519.Verify(pub, input, sig)
				}
				x, y := elliptic.UnmarshalCompressed(elliptic.P256(), pub)
				if x == nil {
					x, y = elliptic.Unmarshal(elliptic.P256(), pub)
				}
				if x == nil || len(sig) != 64 {
					return false
				}
				h := sha256.Sum256(input)
				return ecdsa.Verify(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
			}
			if !verify(input) {
				t.Fatal("independent signature verification")
			}
			if verify(append([]byte("wrong-purpose\x00"), payload...)) {
				t.Fatal("purpose substitution")
			}
			wire := v["wire"].(map[string]any)
			if !bytes.Equal(interopB64(t, wire["payload"].(string)), payload) || !bytes.Equal(interopB64(t, wire["signature"].(string)), sig) {
				t.Fatal("wire wrapper")
			}
		})
	}
}
func TestConnectionWireInteroperability(t *testing.T) {
	v := interopFile(t, "vectors/connection-wire.json")
	bundle := interopHex(t, v["bundleHex"].(string))
	if interopHash(bundle) != v["bundleDigestHex"] {
		t.Fatal("bundle digest")
	}
	value, e := DecodeDeterministic(bundle)
	if e != nil {
		t.Fatal(e)
	}
	reencoded, e := EncodeDeterministic(value)
	if e != nil || !bytes.Equal(reencoded, bundle) {
		t.Fatal("bundle encoding")
	}
	for _, item := range v["objects"].([]any) {
		o := item.(map[string]any)
		t.Run(o["id"].(string), func(t *testing.T) {
			key := interopHex(t, o["publicKeyHex"].(string))
			_, err := VerifySignedPayload(o["type"].(string), interopHex(t, o["coseHex"].(string)), VerifierFunc(func(kid string, input, sig []byte) bool { return kid == o["keyId"] && ed25519.Verify(key, input, sig) }))
			if err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, item := range v["exchanges"].([]any) {
		e := item.(map[string]any)
		request, err := interopJSON([]byte(e["requestUtf8"].(string)))
		if err != nil || !reflect.DeepEqual(request, e["request"]) {
			t.Fatal("request wire mismatch")
		}
		m := request.(map[string]any)
		keys := []string{}
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		expected := map[string]string{"state": "control", "admit": "bundle,control,token", "commit": "admission,bundle,control", "disconnect": "control", "invitations/review": "did,id,token", "conversation-revival": "connectionId,cose,epoch"}
		want := expected[e["operation"].(string)]
		if e["operation"] == "sync" {
			want = "control"
			if _, ok := m["bundle"]; ok {
				want = "admission,bundle,control"
			}
		}
		if strings.Join(keys, ",") != want {
			t.Fatal("closed request shape")
		}
	}
	if _, err := interopJSON([]byte(`{"control":"a","control":"b"}`)); err == nil {
		t.Fatal("duplicate key accepted")
	}
}

func TestPublishedHistoryRejections(t *testing.T) {
	schema := interopFile(t, "schemas/account-history-v7-v8.json")
	vectors := interopFile(t, "vectors/history-negative.json")
	for _, item := range vectors["cases"].([]any) {
		c := item.(map[string]any)
		t.Run(c["id"].(string), func(t *testing.T) {
			v := interopFile(t, "vectors/"+c["fixture"].(string)+".json")
			value := v["history"]
			if value == nil {
				var e error
				value, e = interopJSON(interopB64(t, v["manifestBase64"].(string)))
				if e != nil {
					t.Fatal(e)
				}
			}
			m := value.(map[string]any)
			parent := value
			path := c["path"].([]any)
			for _, k := range path[:len(path)-1] {
				switch k := k.(type) {
				case string:
					parent = parent.(map[string]any)[k]
				case float64:
					parent = parent.([]any)[int(k)]
				}
			}
			key := path[len(path)-1].(string)
			if c["action"] == "delete" {
				delete(parent.(map[string]any), key)
			} else {
				parent.(map[string]any)[key] = c["value"]
			}
			switch c["stage"] {
			case "schema":
				s := schema
				if v["history"] != nil {
					name := "conversation-history"
					if c["fixture"] == "connection-history" {
						name = "connection-history"
					}
					s = schema["definitions"].(map[string]any)[name].(map[string]any)
				}
				if historyShape(schema, s, m) == nil {
					t.Fatal("invalid schema accepted")
				}
			case "ownership":
				if ownedHistory(m) == nil {
					t.Fatal("foreign ownership accepted")
				}
			case "digest":
				if b64Hash(t, m["conversations"]) == m["conversationCheckpointDigest"] {
					t.Fatal("changed digest accepted")
				}
			default:
				t.Fatal("unknown rejection stage")
			}
		})
	}
}
