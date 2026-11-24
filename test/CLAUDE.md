# Writing tests

Extends the root `CLAUDE.md` testing rules (offline suite is the only continuous
layer; never delete or weaken a failing test).

- **Before testing a unit in isolation, list how it could fail**, ideally as
  `test.todo` entries, then write the code. A test written by reading the finished
  code just restates it.
- **A test that breaks under a behaviour-preserving refactor asserts
  implementation.** Don't add it. Examples: an internal name, a call order, an
  exact call count where an upper bound states the real constraint.
- **Never derive an expected value from the code under test.** Comparing two
  calls is fine when equality *is* the property, as with cache hits or fingerprint
  determinism. When a constant is the spec, assert the invariant it must satisfy
  instead of mirroring it (see "the default scope searches every field…" in
  `compiler.test.js`).
- **Source/import/string checks need a reason.** They are justified only when the
  invariant can't be stated as behaviour and breaking it fails silently or only
  after shipping (`packaging.test.js`'s import walk, `$ref`-free schemas).
- **Prove a new test can fail:** break the code it guards, watch it fail, restore.
- **Exact wording is behaviour for model-facing text** (warnings, error
  suggestions, descriptions). The model reads that text, so don't loosen those
  assertions under the refactor rule above.
- **Test at the highest offline boundary that pins the behaviour.** For a tool,
  that is the handler against the stub backend (`handlers.test.js`): input in,
  `structuredContent` out, validated against the tool's output schema. Don't
  duplicate a stronger test one level down.
- **No test-only exports.** Test through the exported function that uses the
  helper.
- **Use the shared harness rather than hand-rolled `fetch` mocks.**
  `test/stub-backend.js` holds one routing table (`makeRouter` plus fixture
  builders) behind two transports: `installFetchStub` for in-process tests and
  `startStubServer` for subprocess/CLI tests. Its header explains why both exist.
  It returns only the fields a query selects and fails on any unrouted request.
  `test/helpers.js` has `captureHandler`, `assertWireValid`, `withClient`,
  `runCli`, the `LIVE` gate and the live fixture ids.
- **A stubbed network failure needs a coded `cause`**, as undici's has
  (`networkError()` in `clients.test.js`). `fetchWithRetry` treats a bare
  `TypeError` as deterministic and does not retry it.
