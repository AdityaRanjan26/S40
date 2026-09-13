# Security & Privacy — S40

Derived from spec §21 plus the security-relevant implications of
`PRODUCT_DIRECTIVES.md` (especially §E–§H, the Support AI). Same labeling
convention: **CONFIRMED** / **PROPOSED** / **UNDECIDED**.

------------------------------------------------------------------------

## 1. Data minimization

**CONFIRMED** (spec §21): only retain information required for risk
evaluation and auditing. The User Risk Profile (spec §7) must be
privacy-minimized, not an unbounded historical store.

## 2. Sensitive identifiers

**CONFIRMED** (spec §21):
- `hash(device_id)`
- `hash(phone_number)`
- Pseudonymous user IDs

**PROPOSED**: use a consistent, documented hashing approach (e.g. salted
SHA-256) applied at the point of ingestion, so raw identifiers never reach
storage. **UNDECIDED**: exact hashing/salting scheme and key management —
to be decided during backend implementation, not invented here.

## 3. Voice/audio handling

**CONFIRMED** (spec §21): do not retain raw audio unless explicitly
required for the demo. Preferred flow:
```
audio → transcription/features → risk analysis → discard raw audio
```
This directly constrains the Voice pipeline (`docs/ML_ARCHITECTURE.md` §5)
and the Support AI's voice interaction feature (`PRODUCT_DIRECTIVES.md`
§F) equally — neither should become a standing store of raw recordings.

## 4. Authentication and authorization

**CONFIRMED** (spec §21):
- JWT/session authentication.
- Role-based access control with roles: `USER`, `INSTITUTION_ANALYST`,
  `ADMIN`.

**UNDECIDED**: session lifetime, token refresh strategy, and whether
institution analysts and admins share a login surface distinct from the
user app — none of this is specified and must be decided during backend
implementation.

## 5. Audit logging

**CONFIRMED** (spec §18, §21): record sensitive operations via the
`audit_logs` table (actor, action, resource, timestamp, metadata).
Applies to at least: risk decisions, user confirm/cancel/report actions,
institution case reviews, and any admin action.

**PROPOSED**: audit log writes should never include raw PII or raw audio
content in the `metadata` field — only references (hashed/pseudonymous
IDs, transaction IDs) per the data-minimization principle above.

## 6. API security / input validation

**CONFIRMED** (spec §3, backend responsibilities): FastAPI + Pydantic used
for schema validation on every endpoint listed in `docs/ARCHITECTURE.md`
§3.

**PROPOSED** (standard practice, not spec-invented architecture):
- Validate and sanitize all request bodies via Pydantic models — reject
  unknown/malformed fields rather than silently ignoring them.
- Rate-limit sensitive endpoints (transaction creation, voice analysis) to
  protect the demo from accidental overload — exact limits **UNDECIDED**.
- Standard OWASP-class protections (parameterized queries via SQLAlchemy,
  no string-built SQL, output encoding on the frontend) apply throughout,
  per the general engineering rules in `CLAUDE.md`.

## 7. Secrets management

**CONFIRMED** (`CLAUDE.md`, general engineering rule): secrets never live
in source code or commits. `.env` files are git-ignored; `.env.example`
documents required variable names with placeholder values only.

## 8. Support AI — prompt injection and action boundaries

**CONFIRMED** (product directive §E, §H): this is a new security surface
not covered by the original spec, since the Support AI is itself a
directive-level addition.

- The Support AI must never invent account actions, financial actions,
  policies, or security decisions.
- Sensitive/high-risk requests must escalate to a human path rather than
  being resolved (or hallucinated) by the AI.
- The Support AI has **no write path** into the fraud decision engine,
  risk scores, or transaction state — read-only access to already-computed,
  already-authorized data only (e.g., "why was my transaction flagged"
  using the existing explanation package, not a live re-evaluation).
- Because the Support AI will process free-form user text (and
  potentially voice), it is a prompt-injection surface: user-supplied
  content must never be interpreted as system-level instructions capable
  of changing its tool access, escalation rules, or the scope of what it's
  permitted to do.

**UNDECIDED**: concrete implementation of the escalation trigger (keyword
rules, classifier, confidence threshold, or a combination) and the exact
list of "sensitive/high-risk" request categories that force escalation.
This needs explicit definition before the Support AI is built, not
improvised during implementation.

## 9. Data retention

**CONFIRMED** (spec §21, product directive §I): minimize retention broadly;
raw audio specifically must not persist beyond feature extraction unless
explicitly required for demo purposes.

**UNDECIDED**: retention period for transaction records, risk scores, and
audit logs in the demo environment. Since this is a prototype using
synthetic data, a generous retention window is likely acceptable, but the
exact number has not been decided and should not be assumed.

## 10. Synthetic / anonymized demo data

**CONFIRMED** (spec §2 Non-Goals, §24): the system uses a realistic
transaction simulator and synthetic/anonymized data — never real financial
credentials, never real-money movement. This is a hard constraint per
`CLAUDE.md` as well.

**CONFIRMED** (product directive §A): demo data should use Indian
names/locations for cultural relevance, while remaining clearly synthetic.

## 11. No proprietary AI dependency for core function

**CONFIRMED** (product directive §G): the shipped application's core AI
functionality (STT, support LLM, TTS, voice/social-engineering analysis)
should not depend on proprietary inference APIs. This is as much a
data-governance decision as an architectural one — it avoids sending
user voice/text content to third-party inference providers by default.

## 12. On-device inference and encryption roadmap

**Not spec-derived** — a direction set later in the project (product
owner decision, not `S40_End_to_End_Project_Plan_FINAL.md`), recorded
here per this file's own convention rather than left undocumented.

**CONFIRMED — threat model for "encrypted in transit":** protection is
against network eavesdroppers, not against the server operator. TLS in
transit (already in place in production —
`https://s44-production.up.railway.app`) plus encryption at rest in the
database is the target; the running API is still expected to decrypt data
server-side when it needs to (serving a request, running a training job).
A design where the server itself never sees plaintext (federated learning,
client-held keys) was explicitly considered and rejected as out of scope.

**CONFIRMED — on-device inference, phased:**
- Transaction fraud (recipient risk): **done**. `fraud_real.onnx` is
  bundled in the mobile app; `RecipientRiskService.estimateLocally`
  (`apps/mobile/src/services/recipient-risk-service.ts`) runs it
  on-device as an advisory-only signal, wired into
  `PaymentService.evaluatePaymentOffline`'s fallback path. Never
  authoritative — `POST /api/v1/risk/evaluate` remains the only
  authoritative decision, per this file's and `risk-service.ts`'s "no
  client-side risk heuristics" doctrine.
- Audio anti-spoofing / synthetic-voice detection: **done**, as a faithful
  port. `apps/mobile/src/services/audio-anti-spoofing.ts` re-implements
  `voice/anti_spoofing/acoustic_analyzer.py` and `detector.py` (pure
  signal-processing math — no trained model ever existed for this
  detector, so there was nothing to export) and is verified against the
  Python original using real recordings in
  `demo_recordings/`. Wired into the mobile "AI Voice Cloning" demo
  scenario against a bundled real recording
  (`apps/mobile/assets/audio/ai_voice_clone_demo.wav`), so that scenario
  computes a genuine on-device result instead of a hardcoded stub.
  **Caveat, stated plainly**: the app still has no real microphone/live
  call-audio capture pipeline at all (checked directly — no `expo-av` or
  equivalent dependency exists). This makes the *algorithm* genuinely
  on-device and provably correct against real audio, but does not yet
  make it usable against a real live call; that needs a separate,
  platform-constrained capture feature (iOS/Android both restrict access
  to live call audio) not yet scoped.
- Voice scam-intent NLP: **done**. `apps/mobile/src/services/nlp/`
  ports the full pipeline — the Aho-Corasick multilingual trie
  (`aho-corasick-trie.ts`, bundling the same lexicon JSON files as-is),
  the rule-based linguistic features and Hinglish preprocessing
  (`voice-features.ts`, `voice-preprocessing.ts`, `code-mixed-
  normalizer.ts`), the leaky-bucket risk accumulator (`leaky-bucket.ts`),
  and the trained `voice_nlp.joblib` TF-IDF/LogisticRegression model
  itself (`voice-tfidf-model.ts`, scored directly from vocabulary/idf/
  coefficients exported from the fitted model into
  `assets/nlp/voice_nlp_model.json` — not retrained, not approximated).
  ONNX export was evaluated and explicitly rejected here: skl2onnx's
  conversion of the TfidfVectorizer needs the `com.microsoft.Tokenizer`
  contrib op, whose support in onnxruntime-react-native's prebuilt
  binary is unverified, whereas a direct math port is fully verifiable.
  Verified against the real Python classifier on English, Hinglish,
  Devanagari, and Bengali test transcripts, including a negation case
  ("please don't share your OTP") that must NOT be flagged — see
  `voice-classifier-parity.regression.ts`. A genuine bug was caught and
  fixed by that parity test during porting (a naive ASCII-only `\w` in
  the text-cleaning step was silently stripping all Devanagari/Bengali
  text before it ever reached the classifier). Wired into
  `voice-service.ts` as the fallback when `/ws/voice-stream` is
  unreachable, replacing what used to be a hardcoded "unavailable"
  degraded state for every demo scenario — not merely for the audio
  scenario. Deliberately NOT ported: Columbo Protocol trap-prompt text
  generation (`engine/copilot/static_trap_prompts.py`) — that's
  supplementary counter-inquiry UX copy, not part of the risk score.
- Behaviour anomaly: **not started**. The IsolationForest model needs an
  on-device export path and the user's historical baseline shipped to the
  device, which the `model-sync`/`UserPatternService` machinery partially
  supports already. Device-risk scoring is a simple deterministic
  heuristic with no model to export.

**CONFIRMED — encryption at rest, phase 1 landed:**
`app/core/field_encryption.py`'s `EncryptedText` (a SQLAlchemy
`TypeDecorator`, Fernet, key `APP_DATA_ENCRYPTION_KEY` — distinct from
`CONTACT_INFO_ENCRYPTION_KEY`) transparently encrypts the free-text
columns that name a recipient/amount/person in plain language:
`Notification.title`/`.body`, `Alert.summary`, `Transaction.location`,
`GuardianRequest.resolution_notes`, `FraudCase.review_notes`. Applying it
required no schema migration (it only changes how the app interprets an
existing `Text`/`String` column, not the column's SQL type) and no
call-site changes (encryption/decryption happens at the ORM boundary, so
Pydantic's `from_attributes` schema serialization gets plaintext
transparently). A value that fails to decrypt is treated as legacy
plaintext (a row written before the column was encrypted) and returned
unchanged rather than blanked — this is a deliberate difference from
`contact_encryption.decrypt_field()`, which returns `""` on failure and
would be wrong here.

Deliberately NOT encrypted, and why: `Recipient.recipient_hash` and
`VoiceAnalysis.transcript_hash` are one-way hashes by original design
(§2 above) — stronger than reversible encryption for data that's never
redisplayed, so `EncryptedText` doesn't apply. `TrustedContact` already
uses hash + masked-display (`contact_phone_hash` / `phone_masked`).
Amounts stay plaintext numeric columns — the server needs them for
training/aggregation regardless, and encrypting a numeric column breaks
arithmetic/sorting for no privacy benefit under the confirmed threat
model.

**UNDECIDED**: whether `StatementLedgerTransaction` or other tables
should get equivalent columns added later; none currently hold free text
worth encrypting (checked directly — that table is amount/timestamp/type/
dedup-hash only, by original design per its own docstring).

------------------------------------------------------------------------

## Summary of open security items requiring a decision

- Hashing/salting scheme and key management for identifiers.
- Session/token lifetime and refresh strategy; analyst/admin login surface.
- Rate-limiting thresholds for sensitive endpoints.
- Retention periods for transactions, risk scores, and audit logs.
- Escalation trigger logic and sensitive-category list for the Support AI.
- Live microphone/call-audio capture pipeline for on-device voice
  anti-spoofing and voice-intent NLP (§12) — not yet scoped,
  platform-constrained.
- On-device export path for the behaviour-anomaly (IsolationForest)
  model (§12).
