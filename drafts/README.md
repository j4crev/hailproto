# RACR Internet-Draft workspace

This directory contains the separate first publication draft. It does not replace
`spec/`, and nothing here has been submitted to the IETF Datatracker.

**RACR Protocol — Recipient-Authorized Content Retrieval**, pronounced “racer,”
is the underlying protocol for exchanging **hail** messages. **Hail** names the
communication medium, and **a hail** is an individual recipient-authorized
message. Identifiers such as `hail.envelope`, `application/hail-body+cbor`, and
`#hail-messaging` remain appropriate names for its objects, formats, and keys.
The pinned Hail specification is the normative source snapshot.

- [Readable draft](draft-creviston-racr-00.txt)
- [HTML rendering](draft-creviston-racr-00.html)
- [Editable RFCXML source](draft-creviston-racr-00.xml)

Author: **Creviston**, **j4@j4crev.com**. The proposed name is
`draft-creviston-racr-00`, an individual submission with provisional intended
status **Experimental**. This is not a working-group document, an adopted
standard, or an RFC. The status and scope remain open to author review.

## Scope and review

The first draft covers architecture and core Grant-authorized delivery, including
discovery, encoding/signatures, permission ordering, body retrieval, mandatory SPT
profiles, status reporting, security/privacy, and registration work. Implemented
connections, threaded replies, shared conversations, and provider transfer are
identified as extensions, not mistaken for missing functionality. General
attachments and advanced publisher layouts remain future work.

It is grounded in the immutable specification snapshot at
`d286113cd82024d009fb07cc60041f290047f148`. Some detailed normative semantics still
depend on that snapshot; this draft is explicitly **not yet a self-contained
implementation specification**. Appendix A distinguishes missing editorial
incorporation from unresolved protocol decisions. Appendix B maps chapters to
source files. Appendix C carries the body CDDL excerpt; its comments are wrapped
for RFC text layout, while its definitions match the snapshot.

Review the architecture and trust boundaries first, then the permission and
failure semantics, then the open issues. In particular, seek feedback on historical
authority after PLC recovery, bearer-token disclosure, response timing, and
extension boundaries. A second deployed provider is not a prerequisite for this
review, and cross-language codec tests are not described as a provider trial.

## Build and validation

Edit the XML source and regenerate both renderings. References are embedded, so
the submission source does not depend on XML include files. Generated renderings
are retained here for review; do not edit them independently.

From the repository root, using Python 3 and Node.js 20 or newer:

```bash
python3 -m venv /tmp/racr-draft-venv
/tmp/racr-draft-venv/bin/pip install xml2rfc==3.35.0
/tmp/racr-draft-venv/bin/xml2rfc --text --html drafts/draft-creviston-racr-00.xml
npx --yes @ietf-tools/idnits@3.3.0 --no-color --no-progress drafts/draft-creviston-racr-00.txt
```

Rendering validates RFCXML and generates the standard boilerplate, contents,
references, expiration date, and author address. Standard submission boilerplate
in the rendered document does not mean a submission has occurred. Passing tools
does not establish protocol completeness, IETF acceptance, or IPR clearance.

Initial validation on 2026-11-02: xml2rfc 3.35.0 produced both renderings
without warnings; idnits 3.3.0 passed with zero errors, warnings, or comments.
Author metadata, internal reference targets, and the body CDDL definitions were
also checked against the source specification. The plain-text rendering is 25
pages. These results describe this local revision, not a submitted document.

## Before submission

1. Review the proposed title, Experimental status, scope, author details, open
   issues, and IPR/submission obligations. Keep unresolved protocol work visible;
   do not remove it simply to make a checklist look complete.
2. Decide how much of the pinned normative specification to incorporate into the
   core document and how to publish its companion extension definitions.
3. Refresh the draft date and reference snapshot deliberately, reconcile any
   intervening protocol changes, regenerate both outputs, and rerun validation.
4. Submit the standalone XML through the
   [Datatracker submission tool](https://datatracker.ietf.org/submit/), review its
   generated metadata and validation results, and complete author confirmation.
   Creating local files or a GitHub PR does not perform this step.
5. Preserve the submitted `-00` source. Subsequent submitted revisions become
   `-01`, `-02`, and so on; that sequence is independent of CLI release versions.

The IETF prefers standalone RFCXML v3 submissions. See its
[submission guidance](https://github.com/ietf/authors.ietf.org/blob/main/submitting-your-internet-draft.md),
[required-content guidance](https://github.com/ietf/authors.ietf.org/blob/main/required-content.md),
[naming guidance](https://github.com/ietf/authors.ietf.org/blob/main/naming-your-internet-draft.md),
and [validation guidance](https://github.com/ietf/authors.ietf.org/blob/main/document-validation.md).

No author outreach, mailing-list post, Datatracker upload, or release publication
is performed by the commands above.
