# Project Notes for Codex

- This repo is on the UNC workspace `\\veronica\mohamed\geocomposer`.
- In the Windows tool environment, mapped drive `X:\geocomposer` may not exist and `apply_patch` may fail on this repo.
- For targeted edits, run PowerShell from `C:\` and use explicit UNC paths.
- Do not run `npm`, build, demo, or test commands unless the user explicitly asks. The user runs project commands on the remote host.
- File-backed source streams must preserve future random-access indexing data. When a `GeoFeature` comes from a file, set `GeoFeature.sourceRef` with the source id plus byte `offset` and `byteLength` of the feature in that source file.
- For GeoJSON, `sourceRef.offset` must point to the opening `{` and `sourceRef.byteLength` must include the closing `}`, so the referenced byte slice is directly `JSON.parse`-able.
- For shapefiles, `sourceRef` must point to the full `.shp` record, including the 8-byte record header, and `sourceRef.related.dbf` must point to the corresponding full DBF record, including the deletion flag byte. This is required for later attribute and R-tree indexes across GeoJSON, shapefile, and similar sources.
- For GML, `sourceRef.offset` must point to the opening `<` of the complete streamed feature element and `sourceRef.byteLength` must include its closing tag. GML axis order is source-dependent; keep `axisOrder` explicit or use `auto` only with known CRS behavior.