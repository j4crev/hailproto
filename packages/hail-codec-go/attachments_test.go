package hailcodec

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestAttachmentVector(t *testing.T) {
	raw, err := os.ReadFile("../../spec/vectors/attachments.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		BodyHex string `json:"bodyHex"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	wire, _ := hex.DecodeString(fixture.BodyHex)
	payload, err := DecodePayload(BodySPT2Type, wire)
	if err != nil {
		t.Fatal(err)
	}
	body := payload.(*SPT2Body)
	if len(body.Attachments) != 1 || body.Attachments[0].Filename != "example.log" {
		t.Fatal("lost attachment metadata")
	}
	encoded, err := EncodePayload(body)
	if err != nil || !bytes.Equal(encoded, wire) {
		t.Fatal("attachment round trip", err)
	}
	body.Attachments[0].Filename = "e\u0301.log"
	if _, err = EncodePayload(body); err == nil {
		t.Fatal("accepted non-NFC filename")
	}
	body.Attachments[0].Filename = "example.log"
	body.Attachments[0].Size = 26214400
	if _, err = EncodePayload(body); err != nil {
		t.Fatal(err)
	}
	body.Attachments = append(body.Attachments, body.Attachments[0])
	if _, err = EncodePayload(body); err == nil {
		t.Fatal("accepted excessive aggregate")
	}
}

func TestPNGAttachmentVector(t *testing.T) {
	raw, err := os.ReadFile("../../spec/vectors/attachment-png.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		BodyHex string `json:"bodyHex"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	wire, _ := hex.DecodeString(fixture.BodyHex)
	payload, err := DecodePayload(BodySPT2Type, wire)
	if err != nil {
		t.Fatal(err)
	}
	body := payload.(*SPT2Body)
	if len(body.Attachments) != 1 || body.Attachments[0].MediaType != "image/png" {
		t.Fatal("PNG metadata lost")
	}
	encoded, err := EncodePayload(body)
	if err != nil || !bytes.Equal(encoded, wire) {
		t.Fatal("PNG attachment round trip", err)
	}
	body.Attachments[0].MediaType = "text/plain"
	if _, err = EncodePayload(body); err == nil {
		t.Fatal("accepted mismatched PNG media type")
	}
}

func TestJPEGWebPAttachmentVectors(t *testing.T) {
	raw, err := os.ReadFile("../../spec/vectors/attachment-images.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Records []struct {
			ID      string `json:"id"`
			BodyHex string `json:"bodyHex"`
		} `json:"records"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, record := range fixture.Records {
		t.Run(record.ID, func(t *testing.T) {
			wire, _ := hex.DecodeString(record.BodyHex)
			payload, err := DecodePayload(BodySPT2Type, wire)
			if err != nil {
				t.Fatal(err)
			}
			body := payload.(*SPT2Body)
			encoded, err := EncodePayload(body)
			if err != nil || !bytes.Equal(encoded, wire) {
				t.Fatal("image attachment round trip", err)
			}
			body.Attachments[0].MediaType = "image/png"
			if _, err = EncodePayload(body); err == nil {
				t.Fatal("accepted mismatched image media type")
			}
		})
	}
}
