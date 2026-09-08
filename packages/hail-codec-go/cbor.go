package hailcodec

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"unicode/utf8"

	"github.com/fxamacker/cbor/v2"
)

type ResourceLimits struct {
	MaximumBytes            int
	MaximumDepth            int
	MaximumItems            int
	MaximumArrayLength      int
	MaximumMapEntries       int
	MaximumTextBytes        int
	MaximumByteStringLength int
}

func DefaultResourceLimits() ResourceLimits {
	return ResourceLimits{262144, 32, 16384, 4096, 256, 262144, 262144}
}

var (
	encMode cbor.EncMode
	decMode cbor.DecMode
)

func init() {
	var err error
	encMode, err = (cbor.EncOptions{Sort: cbor.SortCanonical}).EncMode()
	if err != nil {
		panic(err)
	}
	decMode, err = (cbor.DecOptions{
		DupMapKey:        cbor.DupMapKeyEnforcedAPF,
		IndefLength:      cbor.IndefLengthForbidden,
		TagsMd:           cbor.TagsForbidden,
		IntDec:           cbor.IntDecConvertNone,
		MapKeyByteString: cbor.MapKeyByteStringForbidden,
		UTF8:             cbor.UTF8RejectInvalid,
	}).DecMode()
	if err != nil {
		panic(err)
	}
}

func EncodeDeterministic(value any) ([]byte, error) {
	return EncodeDeterministicWithLimits(value, DefaultResourceLimits())
}

func EncodeDeterministicWithLimits(value any, limits ResourceLimits) ([]byte, error) {
	if err := validateLimits(limits); err != nil {
		return nil, err
	}
	count := 0
	size, err := preflightValue(value, limits, 0, &count)
	if err != nil {
		return nil, err
	}
	if size > uint64(limits.MaximumBytes) {
		return nil, errors.New("resource limit: encoded value too large")
	}
	b, err := encMode.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode CBOR: %w", err)
	}
	if len(b) > limits.MaximumBytes {
		return nil, errors.New("resource limit: encoded value too large")
	}
	return bytes.Clone(b), nil
}

func DecodeDeterministic(data []byte) (any, error) {
	return DecodeDeterministicWithLimits(data, DefaultResourceLimits())
}

func DecodeDeterministicWithLimits(data []byte, limits ResourceLimits) (any, error) {
	if err := validateLimits(limits); err != nil {
		return nil, err
	}
	if len(data) > limits.MaximumBytes {
		return nil, errors.New("resource limit: encoded value too large")
	}
	if err := scanCBOR(data, limits, false, true); err != nil {
		return nil, err
	}
	var value any
	if err := decMode.Unmarshal(data, &value); err != nil {
		return nil, fmt.Errorf("malformed CBOR: %w", err)
	}
	if err := validateValue(value, limits, 0, new(int)); err != nil {
		return nil, err
	}
	reencoded, err := encMode.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("reencode CBOR: %w", err)
	}
	if !bytes.Equal(data, reencoded) {
		return nil, errors.New("CBOR is not deterministic RFC 8949 encoding")
	}
	return cloneValue(value), nil
}

func validateLimits(limits ResourceLimits) error {
	if limits.MaximumBytes < 1 || limits.MaximumDepth < 0 || limits.MaximumItems < 1 || limits.MaximumArrayLength < 0 || limits.MaximumMapEntries < 0 || limits.MaximumTextBytes < 0 || limits.MaximumByteStringLength < 0 {
		return errors.New("invalid resource limits")
	}
	return nil
}

func argumentSize(value uint64) uint64 {
	switch {
	case value < 24:
		return 1
	case value <= math.MaxUint8:
		return 2
	case value <= math.MaxUint16:
		return 3
	case value <= math.MaxUint32:
		return 5
	default:
		return 9
	}
}

func preflightValue(v any, limits ResourceLimits, depth int, count *int) (uint64, error) {
	*count++
	if *count > limits.MaximumItems {
		return 0, errors.New("resource limit: too many values")
	}
	if depth > limits.MaximumDepth {
		return 0, errors.New("resource limit: value nesting too deep")
	}
	switch x := v.(type) {
	case nil, bool:
		return 1, nil
	case int:
		return integerSize(int64(x))
	case int8:
		return integerSize(int64(x))
	case int16:
		return integerSize(int64(x))
	case int32:
		return integerSize(int64(x))
	case int64:
		return integerSize(x)
	case uint:
		return unsignedSize(uint64(x))
	case uint8:
		return unsignedSize(uint64(x))
	case uint16:
		return unsignedSize(uint64(x))
	case uint32:
		return unsignedSize(uint64(x))
	case uint64:
		return unsignedSize(x)
	case string:
		if !utf8.ValidString(x) {
			return 0, errors.New("invalid UTF-8 string")
		}
		if len(x) > limits.MaximumTextBytes {
			return 0, errors.New("resource limit: text string too large")
		}
		return argumentSize(uint64(len(x))) + uint64(len(x)), nil
	case []byte:
		if x == nil {
			return 0, errors.New("typed nil byte strings are prohibited")
		}
		if len(x) > limits.MaximumByteStringLength {
			return 0, errors.New("resource limit: byte string too large")
		}
		return argumentSize(uint64(len(x))) + uint64(len(x)), nil
	case []any:
		if x == nil {
			return 0, errors.New("typed nil arrays are prohibited")
		}
		if len(x) > limits.MaximumArrayLength {
			return 0, errors.New("resource limit: array too large")
		}
		return preflightArray(x, limits, depth, count)
	case map[string]any:
		if x == nil {
			return 0, errors.New("typed nil maps are prohibited")
		}
		if len(x) > limits.MaximumMapEntries {
			return 0, errors.New("resource limit: map too large")
		}
		total := argumentSize(uint64(len(x)))
		for key, value := range x {
			keySize, err := preflightValue(key, limits, depth+1, count)
			if err != nil {
				return 0, err
			}
			valueSize, err := preflightValue(value, limits, depth+1, count)
			if err != nil {
				return 0, err
			}
			total += keySize + valueSize
		}
		return total, nil
	case map[any]any:
		if x == nil {
			return 0, errors.New("typed nil maps are prohibited")
		}
		if len(x) > limits.MaximumMapEntries {
			return 0, errors.New("resource limit: map too large")
		}
		total := argumentSize(uint64(len(x)))
		for key, value := range x {
			textKey, ok := key.(string)
			if !ok {
				return 0, errors.New("map keys must be text")
			}
			keySize, err := preflightValue(textKey, limits, depth+1, count)
			if err != nil {
				return 0, err
			}
			valueSize, err := preflightValue(value, limits, depth+1, count)
			if err != nil {
				return 0, err
			}
			total += keySize + valueSize
		}
		return total, nil
	default:
		return 0, fmt.Errorf("unsupported Hail value %T", v)
	}
}

func preflightArray(values []any, limits ResourceLimits, depth int, count *int) (uint64, error) {
	total := argumentSize(uint64(len(values)))
	for _, value := range values {
		size, err := preflightValue(value, limits, depth+1, count)
		if err != nil {
			return 0, err
		}
		total += size
	}
	return total, nil
}

func integerSize(value int64) (uint64, error) {
	if value < -9007199254740991 || value > 9007199254740991 {
		return 0, errors.New("integer outside Hail safe range")
	}
	if value >= 0 {
		return argumentSize(uint64(value)), nil
	}
	return argumentSize(uint64(-1 - value)), nil
}

func unsignedSize(value uint64) (uint64, error) {
	if value > 9007199254740991 {
		return 0, errors.New("integer outside Hail safe range")
	}
	return argumentSize(value), nil
}

func scanCBOR(data []byte, limits ResourceLimits, allowOuterTag18, requireTextMapKeys bool) error {
	offset, items := 0, 0
	var scan func(int, bool) error
	readArgument := func(ai byte) (uint64, error) {
		if ai < 24 {
			return uint64(ai), nil
		}
		n := 0
		switch ai {
		case 24:
			n = 1
		case 25:
			n = 2
		case 26:
			n = 4
		case 27:
			n = 8
		case 31:
			return 0, errors.New("indefinite CBOR lengths prohibited")
		default:
			return 0, errors.New("invalid CBOR argument")
		}
		if offset+n > len(data) {
			return 0, errors.New("truncated CBOR argument")
		}
		var v uint64
		for range n {
			v = v<<8 | uint64(data[offset])
			offset++
		}
		return v, nil
	}
	scan = func(depth int, outer bool) error {
		items++
		if items > limits.MaximumItems {
			return errors.New("resource limit: too many CBOR items")
		}
		if depth > limits.MaximumDepth {
			return errors.New("resource limit: CBOR nesting too deep")
		}
		if offset >= len(data) {
			return errors.New("truncated CBOR item")
		}
		initial := data[offset]
		offset++
		major, ai := initial>>5, initial&31
		if major == 7 {
			if ai == 20 || ai == 21 || ai == 22 {
				return nil
			}
			return errors.New("CBOR floats and simple values are prohibited")
		}
		arg, err := readArgument(ai)
		if err != nil {
			return err
		}
		switch major {
		case 0, 1:
			if arg > 9007199254740991 {
				return errors.New("integer outside Hail safe range")
			}
		case 2, 3:
			max := limits.MaximumByteStringLength
			if major == 3 {
				max = limits.MaximumTextBytes
			}
			if arg > uint64(max) {
				return errors.New("resource limit: CBOR string too large")
			}
			if arg > uint64(len(data)-offset) {
				return errors.New("truncated CBOR string")
			}
			if major == 3 && !utf8.Valid(data[offset:offset+int(arg)]) {
				return errors.New("invalid UTF-8")
			}
			offset += int(arg)
		case 4:
			if arg > uint64(limits.MaximumArrayLength) {
				return errors.New("resource limit: array too large")
			}
			for range arg {
				if err := scan(depth+1, false); err != nil {
					return err
				}
			}
		case 5:
			if arg > uint64(limits.MaximumMapEntries) {
				return errors.New("resource limit: map too large")
			}
			for range arg {
				if requireTextMapKeys && (offset >= len(data) || data[offset]>>5 != 3) {
					return errors.New("map keys must be text")
				}
				if err := scan(depth+1, false); err != nil {
					return err
				}
				if err := scan(depth+1, false); err != nil {
					return err
				}
			}
		case 6:
			if !allowOuterTag18 || !outer || arg != 18 {
				return errors.New("CBOR tags are prohibited")
			}
			if err := scan(depth+1, false); err != nil {
				return err
			}
		default:
			return errors.New("unknown CBOR major type")
		}
		return nil
	}
	if err := scan(0, true); err != nil {
		return err
	}
	if offset != len(data) {
		return errors.New("trailing CBOR data prohibited")
	}
	return nil
}

func validateValue(v any, limits ResourceLimits, depth int, count *int) error {
	*count++
	if *count > limits.MaximumItems || depth > limits.MaximumDepth {
		return errors.New("resource limit exceeded")
	}
	switch x := v.(type) {
	case nil, bool, string, []byte:
		return nil
	case uint64:
		if x > math.MaxInt64 || x > 9007199254740991 {
			return errors.New("integer outside Hail safe range")
		}
	case int64:
		if x < -9007199254740991 {
			return errors.New("integer outside Hail safe range")
		}
	case []any:
		if len(x) > limits.MaximumArrayLength {
			return errors.New("array too large")
		}
		for _, e := range x {
			if err := validateValue(e, limits, depth+1, count); err != nil {
				return err
			}
		}
	case map[any]any:
		if len(x) > limits.MaximumMapEntries {
			return errors.New("map too large")
		}
		for k, e := range x {
			if _, ok := k.(string); !ok {
				return errors.New("map keys must be text")
			}
			if err := validateValue(e, limits, depth+1, count); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("unsupported Hail value %T", v)
	}
	return nil
}

func cloneValue(v any) any {
	switch x := v.(type) {
	case []byte:
		return bytes.Clone(x)
	case []any:
		out := make([]any, len(x))
		for i := range x {
			out[i] = cloneValue(x[i])
		}
		return out
	case map[any]any:
		out := make(map[any]any, len(x))
		for k, e := range x {
			out[k] = cloneValue(e)
		}
		return out
	default:
		return v
	}
}
