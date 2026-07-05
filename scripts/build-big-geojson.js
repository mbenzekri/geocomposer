"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
Object.defineProperty(exports, "__esModule", { value: true });
var node_fs_1 = require("node:fs");
var promises_1 = require("node:fs/promises");
var node_path_1 = require("node:path");
var node_events_1 = require("node:events");
var gzip_tools_js_1 = require("../src/core/gzip-tools.js");
var geojson_feature_stream_js_1 = require("../src/source/geojson-feature-stream.js");
var configPath = process.argv[2];
if (!configPath) {
    console.error('Usage: npx tsx scripts/build-big-geojson.ts <config.json>');
    process.exit(1);
}
try {
    var config = await readConfig(configPath);
    var downloaded = await downloadAll(config);
    var stats = await mergeGeoJsonFiles(config, downloaded);
    console.log(JSON.stringify({
        output: config.output,
        downloadedFiles: downloaded.length,
        downloadedBytes: downloaded.reduce(function (sum, file) { return sum + file.bytes; }, 0),
        mergedFiles: stats.files,
        features: stats.features
    }, undefined, 2));
}
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
function readConfig(path) {
    return __awaiter(this, void 0, void 0, function () {
        var config, _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _b = (_a = JSON).parse;
                    return [4 /*yield*/, (0, promises_1.readFile)(path, 'utf8')];
                case 1:
                    config = _b.apply(_a, [_c.sent()]);
                    if (!config.downloadDir || typeof config.downloadDir !== 'string') {
                        throw new Error('Config must define downloadDir');
                    }
                    if (!config.output || typeof config.output !== 'string') {
                        throw new Error('Config must define output');
                    }
                    if (!Array.isArray(config.urls) || config.urls.some(function (url) { return typeof url !== 'string'; })) {
                        throw new Error('Config must define urls as a string array');
                    }
                    return [2 /*return*/, {
                            downloadDir: config.downloadDir,
                            output: config.output,
                            urls: config.urls,
                            concurrency: positiveInteger(config.concurrency, 3, 'concurrency'),
                            highWaterMark: positiveInteger(config.highWaterMark, 1024 * 1024, 'highWaterMark')
                        }];
            }
        });
    });
}
function downloadAll(config) {
    return __awaiter(this, void 0, void 0, function () {
        function worker() {
            return __awaiter(this, void 0, void 0, function () {
                var index, url, path, _a, _b;
                return __generator(this, function (_c) {
                    switch (_c.label) {
                        case 0:
                            index = nextIndex;
                            nextIndex += 1;
                            if (index >= config.urls.length)
                                return [2 /*return*/];
                            url = config.urls[index];
                            path = (0, node_path_1.join)(config.downloadDir, filenameFromUrl(url));
                            _a = files;
                            _b = index;
                            return [4 /*yield*/, download(url, path)];
                        case 1:
                            _a[_b] = _c.sent();
                            console.log("[download] ".concat(index + 1, "/").concat(config.urls.length, " ").concat(path, " ").concat(files[index].bytes, " bytes"));
                            _c.label = 2;
                        case 2: return [3 /*break*/, 0];
                        case 3: return [2 /*return*/];
                    }
                });
            });
        }
        var files, nextIndex;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdir)(config.downloadDir, { recursive: true })];
                case 1:
                    _b.sent();
                    files = new Array(config.urls.length);
                    nextIndex = 0;
                    return [4 /*yield*/, Promise.all(Array.from({ length: Math.min((_a = config.concurrency) !== null && _a !== void 0 ? _a : 3, config.urls.length) }, function () { return worker(); }))];
                case 2:
                    _b.sent();
                    return [2 /*return*/, files];
            }
        });
    });
}
function download(url, path) {
    return __awaiter(this, void 0, void 0, function () {
        var existingSize, headers, response, append, output, _a, _b, _c, chunk, e_1_1;
        var _d;
        var _e, e_1, _f, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0: return [4 /*yield*/, fileSize(path)];
                case 1:
                    existingSize = _h.sent();
                    headers = {};
                    if (existingSize > 0)
                        headers.Range = "bytes=".concat(existingSize, "-");
                    return [4 /*yield*/, fetch(url, { headers: headers })];
                case 2:
                    response = _h.sent();
                    if (response.status === 416 && existingSize > 0) {
                        return [2 /*return*/, { url: url, path: path, bytes: existingSize }];
                    }
                    if (!response.ok && response.status !== 206) {
                        throw new Error("Download failed ".concat(response.status, " ").concat(response.statusText, ": ").concat(url));
                    }
                    if (!response.body) {
                        throw new Error("Download response has no body: ".concat(url));
                    }
                    append = response.status === 206 && existingSize > 0;
                    output = (0, node_fs_1.createWriteStream)(path, {
                        flags: append ? 'a' : 'w'
                    });
                    _h.label = 3;
                case 3:
                    _h.trys.push([3, , 17, 19]);
                    _h.label = 4;
                case 4:
                    _h.trys.push([4, 10, 11, 16]);
                    _a = true, _b = __asyncValues(response.body);
                    _h.label = 5;
                case 5: return [4 /*yield*/, _b.next()];
                case 6:
                    if (!(_c = _h.sent(), _e = _c.done, !_e)) return [3 /*break*/, 9];
                    _g = _c.value;
                    _a = false;
                    chunk = _g;
                    return [4 /*yield*/, write(output, Buffer.from(chunk))];
                case 7:
                    _h.sent();
                    _h.label = 8;
                case 8:
                    _a = true;
                    return [3 /*break*/, 5];
                case 9: return [3 /*break*/, 16];
                case 10:
                    e_1_1 = _h.sent();
                    e_1 = { error: e_1_1 };
                    return [3 /*break*/, 16];
                case 11:
                    _h.trys.push([11, , 14, 15]);
                    if (!(!_a && !_e && (_f = _b.return))) return [3 /*break*/, 13];
                    return [4 /*yield*/, _f.call(_b)];
                case 12:
                    _h.sent();
                    _h.label = 13;
                case 13: return [3 /*break*/, 15];
                case 14:
                    if (e_1) throw e_1.error;
                    return [7 /*endfinally*/];
                case 15: return [7 /*endfinally*/];
                case 16: return [3 /*break*/, 19];
                case 17:
                    output.end();
                    return [4 /*yield*/, (0, node_events_1.once)(output, 'finish')];
                case 18:
                    _h.sent();
                    return [7 /*endfinally*/];
                case 19:
                    _d = { url: url, path: path };
                    return [4 /*yield*/, fileSize(path)];
                case 20: return [2 /*return*/, (_d.bytes = _h.sent(), _d)];
            }
        });
    });
}
function mergeGeoJsonFiles(config, files) {
    return __awaiter(this, void 0, void 0, function () {
        var tempOutput, output, writer, features, mergedFiles, _i, files_1, file, count;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdir)((0, node_path_1.dirname)(config.output), { recursive: true })];
                case 1:
                    _b.sent();
                    tempOutput = config.output.endsWith('.gz')
                        ? "".concat(config.output, ".tmp.gz")
                        : "".concat(config.output, ".tmp");
                    output = (0, gzip_tools_js_1.openPossiblyGzippedWriteStream)(tempOutput, {
                        highWaterMark: config.highWaterMark
                    });
                    writer = new geojson_feature_stream_js_1.GeoJsonFeatureCollectionWriter(function (chunk) { return write(output.stream, chunk); });
                    features = 0;
                    mergedFiles = 0;
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, , 9, 11]);
                    return [4 /*yield*/, writer.open()];
                case 3:
                    _b.sent();
                    _i = 0, files_1 = files;
                    _b.label = 4;
                case 4:
                    if (!(_i < files_1.length)) return [3 /*break*/, 7];
                    file = files_1[_i];
                    return [4 /*yield*/, appendGeoJsonFeatures(file.path, writer, (_a = config.highWaterMark) !== null && _a !== void 0 ? _a : 1024 * 1024)];
                case 5:
                    count = _b.sent();
                    features += count;
                    mergedFiles += 1;
                    console.log("[merge] ".concat(mergedFiles, "/").concat(files.length, " ").concat(file.path, " ").concat(count, " features"));
                    _b.label = 6;
                case 6:
                    _i++;
                    return [3 /*break*/, 4];
                case 7: return [4 /*yield*/, writer.close()];
                case 8:
                    _b.sent();
                    return [3 /*break*/, 11];
                case 9:
                    output.stream.end();
                    return [4 /*yield*/, (0, node_events_1.once)(output.stream, 'finish')];
                case 10:
                    _b.sent();
                    return [7 /*endfinally*/];
                case 11: return [4 /*yield*/, (0, promises_1.rename)(tempOutput, config.output)];
                case 12:
                    _b.sent();
                    return [2 /*return*/, { files: mergedFiles, features: features }];
            }
        });
    });
}
function appendGeoJsonFeatures(path, writer, highWaterMark) {
    return __awaiter(this, void 0, void 0, function () {
        var input, parser, count, _a, _b, _c, chunk, parsed, e_2_1;
        var _d, e_2, _e, _f;
        return __generator(this, function (_g) {
            switch (_g.label) {
                case 0:
                    input = (0, gzip_tools_js_1.openPossiblyGzippedReadStream)(path, {
                        highWaterMark: highWaterMark
                    });
                    parser = new geojson_feature_stream_js_1.GeoJsonFeatureCollectionParser('utf8');
                    count = 0;
                    _g.label = 1;
                case 1:
                    _g.trys.push([1, , 17, 18]);
                    _g.label = 2;
                case 2:
                    _g.trys.push([2, 10, 11, 16]);
                    _a = true, _b = __asyncValues(input.stream);
                    _g.label = 3;
                case 3: return [4 /*yield*/, _b.next()];
                case 4:
                    if (!(_c = _g.sent(), _d = _c.done, !_d)) return [3 /*break*/, 9];
                    _f = _c.value;
                    _a = false;
                    chunk = _f;
                    parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    _g.label = 5;
                case 5:
                    parsed = parser.read();
                    if (!parsed)
                        return [3 /*break*/, 8];
                    return [4 /*yield*/, writer.writeFeatureRaw(parsed.raw)];
                case 6:
                    _g.sent();
                    count += 1;
                    _g.label = 7;
                case 7: return [3 /*break*/, 5];
                case 8:
                    _a = true;
                    return [3 /*break*/, 3];
                case 9: return [3 /*break*/, 16];
                case 10:
                    e_2_1 = _g.sent();
                    e_2 = { error: e_2_1 };
                    return [3 /*break*/, 16];
                case 11:
                    _g.trys.push([11, , 14, 15]);
                    if (!(!_a && !_d && (_e = _b.return))) return [3 /*break*/, 13];
                    return [4 /*yield*/, _e.call(_b)];
                case 12:
                    _g.sent();
                    _g.label = 13;
                case 13: return [3 /*break*/, 15];
                case 14:
                    if (e_2) throw e_2.error;
                    return [7 /*endfinally*/];
                case 15: return [7 /*endfinally*/];
                case 16:
                    parser.finish();
                    return [3 /*break*/, 18];
                case 17:
                    input.close();
                    return [7 /*endfinally*/];
                case 18: return [2 /*return*/, count];
            }
        });
    });
}
function write(stream, chunk) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (stream.write(chunk))
                        return [2 /*return*/];
                    return [4 /*yield*/, (0, node_events_1.once)(stream, 'drain')];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function fileSize(path) {
    return __awaiter(this, void 0, void 0, function () {
        var error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, (0, promises_1.stat)(path)];
                case 1: return [2 /*return*/, (_a.sent()).size];
                case 2:
                    error_1 = _a.sent();
                    if (error_1.code === 'ENOENT')
                        return [2 /*return*/, 0];
                    throw error_1;
                case 3: return [2 /*return*/];
            }
        });
    });
}
function filenameFromUrl(value) {
    var url = new URL(value);
    var name = (0, node_path_1.basename)(url.pathname);
    if (!name)
        throw new Error("URL has no filename: ".concat(value));
    return name;
}
function positiveInteger(value, fallback, name) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || Number(value) <= 0) {
        throw new Error("Config ".concat(name, " must be a positive integer"));
    }
    return Number(value);
}
