# Plugin routing evaluation

These fixtures evaluate whether Codex loads the YouTube plugin only when useful. They are data, not automated unit tests.

- `direct.jsonl`: 10 prompts that explicitly name YouTube.
- `indirect.jsonl`: 10 prompts whose YouTube intent is implicit.
- `unrelated-negative.jsonl`: the shared 10-prompt negative set, identical in the Steam repository.
- `result.schema.json`: one JSONL result record schema.

For a manual run, install the source plugin through the normal reviewed workflow, start a fresh Codex task for every fixture, submit only its `prompt`, and record selected plugins/tools. Compare `selected_plugins` with `expected_plugin`; `null` means neither Steam nor YouTube should load. Do not reuse tasks because earlier discovery changes context.

Write results to `results/YYYY-MM-DD-runtime.jsonl`, validate each record against `result.schema.json`, and report direct recall, indirect recall, negative precision, wrong-plugin selection, and tool-call success separately.

Status: fixtures and schema prepared; no new Codex tasks were created and no routing run has been executed.
