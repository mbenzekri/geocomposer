# Project Notes for Codex

## Collaboration policy

- Do not modify files, generate patches, run formatters, or alter project state without the user's explicit approval for that specific change. Analysis, reading files, and reporting findings are allowed; implementation requires a clear "go" from the user.
- Treat `perf-conf/` as read-only, including its symlink target. Do not edit, regenerate, chmod, delete, or overwrite files under `perf-conf/` unless the user explicitly approves that exact change.

- Prefer the simplest direct implementation that satisfies the request.
- Do not introduce new classes, services, option holders, registries, factories, or abstraction layers unless the user explicitly asks for them or there is already an established project pattern that requires it.
- For global server-wide settings, prefer direct config-owned variables or existing config structures over new wrapper objects.
- When the user says "simple", "première étape", or pushes back on complexity, stop abstracting and reduce the change to the smallest working code path.
- Before adding a new abstraction, justify why a plain variable, function, or existing class field is insufficient.
- The user strongly prefers simple, direct code. Avoid "architecture" for small features. In particular, do not create small classes such as `Options`, `Manager`, `Builder`, `Factory`, or `Service` just to hold two values or wrap straightforward behavior.

- File-backed source streams must preserve future random-access indexing data. When a `Feature` comes from a file, set `Feature.sourceRef` with the source id plus byte `offset` and `byteLength` of the feature in that source file.
- For GeoJSON, `sourceRef.offset` must point to the opening `{` and `sourceRef.byteLength` must include the closing `}`, so the referenced byte slice is directly `JSON.parse`-able.
- For shapefiles, `sourceRef` must point to the full `.shp` record, including the 8-byte record header, and `sourceRef.related.dbf` must point to the corresponding full DBF record, including the deletion flag byte. This is required for later attribute and R-tree indexes across GeoJSON, shapefile, and similar sources.
- For GML, `sourceRef.offset` must point to the opening `<` of the complete streamed feature element and `sourceRef.byteLength` must include its closing tag. GML axis order is source-dependent; keep `axisOrder` explicit or use `auto` only with known CRS behavior.
- Do not introduce GDAL/OGR in this project. Geo formats must be handled natively or through focused non-GDAL libraries.
- Keep source abstractions separated: `FileSource` is for byte-range indexable files, while `DbSource` is for sources such as GeoPackage that carry their own table/index model.

## Coding style

- Object-oriented design is mandatory. Prefer classes, encapsulated services, and explicit domain objects for new behavior instead of procedural modules built mostly from standalone functions.
- Code changes must leave the touched area clean: remove helpers, functions, classes, imports, variables, and tests that become unused or obsolete because of the change. Do not leave dead code, duplicated utilities, or "maybe useful later" helpers behind.
- Before adding a helper, search for an existing equivalent and reuse it when it fits. If a new helper replaces old logic, delete the old logic in the same change.
- After non-trivial edits, check the symbols you introduced or replaced with `rg` or the existing type/lint tooling to catch unused code and accidental duplication before reporting the work as done.

## Shell policy

- Prefer bash-compatible commands whenever possible.
- Prefer portable Python or Node.js scripts for non-trivial file transformations.
- Minimize shell-specific syntax.

## Reliability policy

- Prefer deterministic scripts over shell one-liners.
- Avoid fragile regex replacements when AST-based tools exist.
- Batch related file modifications into a single script execution.
- Before editing many files, first analyze repository structure and conventions.

## Test policy

- Tests, fixtures, and demos must adapt to the current production API and configuration contract. Do not preserve compatibility shims, alternate constructors, or legacy options only to keep old tests working; keep backward compatibility only when it is required by real production users or documented public API.

## Token efficiency

- If shell complexity increases, switch to Python scripting immediately.
- Avoid retry loops caused by shell incompatibilities.
