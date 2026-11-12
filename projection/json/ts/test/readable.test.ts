/*
 * Every case of projection/json/vectors/readable.json against the ./readable entry point
 * (ontos-readable-json/1): reads, refusals with code, path, UTF-8 span and kind, origins,
 * writes, write refusals, limits and the laws. The replay is in ./vectors.ts.
 */

import * as readable from "../dist/src/readable.js";
import { replay } from "./vectors.ts";

replay("readable", readable);
