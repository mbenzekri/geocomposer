# Project Notes for Codex

- This repo is on the UNC workspace `\\veronica\mohamed\geocomposer`.
- In the Windows tool environment, mapped drive `X:\geocomposer` may not exist and `apply_patch` may fail on this repo.
- For targeted edits, run PowerShell from `C:\` and use explicit UNC paths.
- Do not run `npm`, build, demo, or test commands unless the user explicitly asks. The user runs project commands on the remote host.
- File-backed source streams must preserve future random-access indexing data. When a `GeoFeature` comes from a file, set `GeoFeature.sourceRef` with the source id plus byte `offset` and `byteLength` of the feature in that source file.
- For GeoJSON, `sourceRef.offset` must point to the opening `{` and `sourceRef.byteLength` must include the closing `}`, so the referenced byte slice is directly `JSON.parse`-able.
- For shapefiles, `sourceRef` must point to the full `.shp` record, including the 8-byte record header, and `sourceRef.related.dbf` must point to the corresponding full DBF record, including the deletion flag byte. This is required for later attribute and R-tree indexes across GeoJSON, shapefile, and similar sources.
- For GML, `sourceRef.offset` must point to the opening `<` of the complete streamed feature element and `sourceRef.byteLength` must include its closing tag. GML axis order is source-dependent; keep `axisOrder` explicit or use `auto` only with known CRS behavior.
- Do not introduce GDAL/OGR in this project. Geo formats must be handled natively or through focused non-GDAL libraries.
- Keep source abstractions separated: `FileGeoSource` is for byte-range indexable files, while `DatabaseGeoSource` is for sources such as GeoPackage that carry their own table/index model.

## Shell policy

- Prefer bash-compatible commands whenever possible.
- Avoid PowerShell unless the task is explicitly Windows-specific.
- Prefer portable Python or Node.js scripts for non-trivial file transformations.
- Avoid complex PowerShell pipelines.
- Minimize shell-specific syntax.
- Use UTF-8 explicitly when generating files on Windows.
- Prefer cross-platform tooling.

## Reliability policy

- Prefer deterministic scripts over shell one-liners.
- Avoid fragile regex replacements when AST-based tools exist.
- Batch related file modifications into a single script execution.
- Before editing many files, first analyze repository structure and conventions.

## Token efficiency

- Do not spend iterations adapting Unix commands to PowerShell.
- If shell complexity increases, switch to Python scripting immediately.
- Avoid retry loops caused by shell incompatibilities.
