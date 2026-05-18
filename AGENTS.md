# Project Notes for Codex

- `npm run build` is allowed when checking or fixing TypeScript compilation. Demo and test commands still require an explicit user request.
- File-backed source streams must preserve future random-access indexing data. When a `Feature` comes from a file, set `Feature.sourceRef` with the source id plus byte `offset` and `byteLength` of the feature in that source file.
- For GeoJSON, `sourceRef.offset` must point to the opening `{` and `sourceRef.byteLength` must include the closing `}`, so the referenced byte slice is directly `JSON.parse`-able.
- For shapefiles, `sourceRef` must point to the full `.shp` record, including the 8-byte record header, and `sourceRef.related.dbf` must point to the corresponding full DBF record, including the deletion flag byte. This is required for later attribute and R-tree indexes across GeoJSON, shapefile, and similar sources.
- For GML, `sourceRef.offset` must point to the opening `<` of the complete streamed feature element and `sourceRef.byteLength` must include its closing tag. GML axis order is source-dependent; keep `axisOrder` explicit or use `auto` only with known CRS behavior.
- Do not introduce GDAL/OGR in this project. Geo formats must be handled natively or through focused non-GDAL libraries.
- Keep source abstractions separated: `FileSource` is for byte-range indexable files, while `DbSource` is for sources such as GeoPackage that carry their own table/index model.

## Refactor proposals

- P1: Shorter names. Prefer concise, explicit names over Java-style long compounds. Avoid `Geo` prefixes unless they remove real ambiguity.
- P2: Add more OO around behavior-rich concepts such as map render jobs and views.
- P3: Keep feature and geometry payloads as simple serializable objects.
- P4: Split format sources from readers/parsers when a source starts doing too much.
- P5: Use a small stable vocabulary: `Source`, `Reader`, `Filter`, `Projector`, `Renderer`, `StyleFn`, `View`.
- P6: Apply the style incrementally instead of doing unrelated broad refactors.

## Shell policy

- Prefer bash-compatible commands whenever possible.
- Prefer portable Python or Node.js scripts for non-trivial file transformations.
- Minimize shell-specific syntax.

## Reliability policy

- Prefer deterministic scripts over shell one-liners.
- Avoid fragile regex replacements when AST-based tools exist.
- Batch related file modifications into a single script execution.
- Before editing many files, first analyze repository structure and conventions.

## Token efficiency

- If shell complexity increases, switch to Python scripting immediately.
- Avoid retry loops caused by shell incompatibilities.
